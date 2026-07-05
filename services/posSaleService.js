/**
 * @file posSaleService.js
 * @description Business logic for POS sales and returns.
 */

import db from "../config/db.js";
import { ensurePosSchema } from "../utils/posSchema.js";
import { ensureFinancialColumns } from "../utils/financialSchema.js";
import { deductStockItems, restoreStockItems } from "../utils/variantStock.js";
import { logInventoryMovements } from "./inventoryMovementService.js";

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

function normalizeDiscountType(type) {
  if (type === "percent" || type === "fixed") return type;
  return "none";
}

export function calculateItemPricing(originalUnitPrice, discountType, discountValue) {
  const price = roundMoney(originalUnitPrice);
  const type = normalizeDiscountType(discountType);
  const value = roundMoney(discountValue || 0);

  if (type === "none" || value <= 0) {
    return {
      itemDiscountType: "none",
      itemDiscountValue: 0,
      itemDiscountAmount: 0,
      finalUnitPrice: price,
    };
  }

  if (type === "percent") {
    const pct = Math.min(Math.max(value, 0), 100);
    const discountAmount = roundMoney((price * pct) / 100);
    return {
      itemDiscountType: "percent",
      itemDiscountValue: pct,
      itemDiscountAmount: discountAmount,
      finalUnitPrice: roundMoney(Math.max(price - discountAmount, 0)),
    };
  }

  const discountAmount = roundMoney(Math.min(value, price));
  return {
    itemDiscountType: "fixed",
    itemDiscountValue: value,
    itemDiscountAmount: discountAmount,
    finalUnitPrice: roundMoney(Math.max(price - discountAmount, 0)),
  };
}

export function calculateCartTotals(lineItems, cartDiscountType, cartDiscountValue) {
  const subtotalBeforeDiscount = roundMoney(
    lineItems.reduce(
      (sum, item) => sum + item.original_unit_price * item.quantity,
      0,
    ),
  );

  const itemsDiscountTotal = roundMoney(
    lineItems.reduce(
      (sum, item) => sum + item.item_discount_amount * item.quantity,
      0,
    ),
  );

  const itemsSubtotal = roundMoney(
    lineItems.reduce((sum, item) => sum + item.line_subtotal, 0),
  );

  const cartType = normalizeDiscountType(cartDiscountType);
  const cartValue = roundMoney(cartDiscountValue || 0);
  let cartDiscountAmount = 0;

  if (cartType === "percent" && cartValue > 0) {
    const pct = Math.min(Math.max(cartValue, 0), 100);
    cartDiscountAmount = roundMoney((itemsSubtotal * pct) / 100);
  } else if (cartType === "fixed" && cartValue > 0) {
    cartDiscountAmount = roundMoney(Math.min(cartValue, itemsSubtotal));
  }

  const finalTotal = roundMoney(Math.max(itemsSubtotal - cartDiscountAmount, 0));
  const profitBeforeDiscount = roundMoney(
    lineItems.reduce(
      (sum, item) => sum + item.unit_net_profit * item.quantity,
      0,
    ),
  );

  // Scale profit by what was actually collected vs the original list value
  // (covers both item-level and cart-level discounts).
  const profitRatio =
    subtotalBeforeDiscount > 0 ? finalTotal / subtotalBeforeDiscount : 0;
  const totalNetProfit = roundMoney(
    Math.min(profitBeforeDiscount * profitRatio, finalTotal),
  );

  return {
    subtotalBeforeDiscount,
    itemsDiscountTotal,
    itemsSubtotal,
    cartDiscountType: cartType,
    cartDiscountValue: cartType === "none" ? 0 : cartValue,
    cartDiscountAmount,
    finalTotal,
    totalNetProfit,
    itemsCount: lineItems.reduce((sum, item) => sum + item.quantity, 0),
  };
}

async function generateReceiptNumber(connection, transactionType) {
  const prefix = transactionType === "return" ? "RET" : "POS";
  const now = new Date();
  const datePart = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("");

  const [rows] = await connection.query(
    `
      SELECT receipt_number
      FROM pos_sales
      WHERE receipt_number LIKE ?
      ORDER BY id DESC
      LIMIT 1
    `,
    [`${prefix}-${datePart}-%`],
  );

  let sequence = 1;
  if (rows.length) {
    const lastPart = rows[0].receipt_number.split("-").pop();
    sequence = Number.parseInt(lastPart, 10) + 1;
  }

  return `${prefix}-${datePart}-${String(sequence).padStart(4, "0")}`;
}

async function lockAndLoadProducts(connection, items) {
  const productIds = [...new Set(items.map((i) => i.product_id))];
  const variantIds = [
    ...new Set(items.filter((i) => i.variant_id).map((i) => i.variant_id)),
  ];

  if (productIds.length) {
    await connection.query(
      "SELECT id, price, net_profit, is_active, stock FROM products WHERE id IN (?) FOR UPDATE",
      [productIds],
    );
  }

  if (variantIds.length) {
    await connection.query(
      `
        SELECT pv.id, pv.product_id, pv.stock, pv.product_color_id, pv.size_value,
               pc.name AS color_name, pc.value AS color_value
        FROM product_variants pv
        LEFT JOIN product_colors pc ON pc.id = pv.product_color_id
        WHERE pv.id IN (?)
        FOR UPDATE
      `,
      [variantIds],
    );
  }

  const [products] = await connection.query(
    `
      SELECT id, name, price, net_profit, is_active, stock
      FROM products
      WHERE id IN (?)
    `,
    [productIds],
  );
  const productsById = new Map(products.map((p) => [p.id, p]));

  let variantsById = new Map();
  if (variantIds.length) {
    const [variants] = await connection.query(
      `
        SELECT pv.id, pv.product_id, pv.stock, pv.product_color_id, pv.size_value,
               pc.name AS color_name, pc.value AS color_value
        FROM product_variants pv
        LEFT JOIN product_colors pc ON pc.id = pv.product_color_id
        WHERE pv.id IN (?)
      `,
      [variantIds],
    );
    variantsById = new Map(variants.map((v) => [v.id, v]));
  }

  return { productsById, variantsById };
}

function resolveVariantImage(connection, productId, colorId) {
  return connection.query(
    `
      SELECT image_url
      FROM product_color_images
      WHERE product_color_id = ?
      ORDER BY is_main DESC, id ASC
      LIMIT 1
    `,
    [colorId],
  );
}

async function buildSaleLineItems(connection, rawItems) {
  const { productsById, variantsById } = await lockAndLoadProducts(connection, rawItems);

  const productIds = [...productsById.keys()];
  const variantCountByProduct = new Map();
  if (productIds.length) {
    const [variantCounts] = await connection.query(
      `
        SELECT product_id, COUNT(*) AS variant_count
        FROM product_variants
        WHERE product_id IN (?)
        GROUP BY product_id
      `,
      [productIds],
    );
    for (const row of variantCounts) {
      variantCountByProduct.set(row.product_id, Number(row.variant_count));
    }
  }

  const lineItems = [];

  for (const raw of rawItems) {
    const productId = Number(raw.product_id);
    const variantId = raw.variant_id ? Number(raw.variant_id) : null;
    const quantity = Number.parseInt(raw.quantity, 10) || 1;

    if (!productId || quantity < 1) {
      const error = new Error("Invalid cart item.");
      error.status = 400;
      throw error;
    }

    const product = productsById.get(productId);
    if (!product || !product.is_active) {
      const error = new Error(`Product #${productId} is unavailable.`);
      error.status = 400;
      throw error;
    }

    const productVariantCount = variantCountByProduct.get(productId) || 0;
    if (productVariantCount > 0 && !variantId) {
      const error = new Error(`Variant selection is required for "${product.name}".`);
      error.status = 400;
      throw error;
    }

    const variant = variantId ? variantsById.get(variantId) : null;
    if (variantId && (!variant || variant.product_id !== productId)) {
      const error = new Error("Invalid product variant selection.");
      error.status = 400;
      throw error;
    }

    const pricing = calculateItemPricing(
      product.price,
      raw.item_discount_type,
      raw.item_discount_value,
    );

    let selectedImageUrl = raw.selected_image_url || null;
    if (!selectedImageUrl && variant?.product_color_id) {
      const [[imageRow]] = await resolveVariantImage(
        connection,
        productId,
        variant.product_color_id,
      );
      selectedImageUrl = imageRow?.image_url || null;
    }

    if (!selectedImageUrl) {
      const [[generalImage]] = await connection.query(
        `
          SELECT image_url
          FROM product_images
          WHERE product_id = ?
          ORDER BY is_main DESC, id ASC
          LIMIT 1
        `,
        [productId],
      );
      selectedImageUrl = generalImage?.image_url || null;
    }

    lineItems.push({
      product_id: productId,
      variant_id: variantId,
      product_name: product.name,
      selected_size: variant?.size_value || null,
      selected_color_name: variant?.color_name || null,
      selected_color_value: variant?.color_value || null,
      selected_image_url: selectedImageUrl,
      quantity,
      original_unit_price: roundMoney(product.price),
      item_discount_type: pricing.itemDiscountType,
      item_discount_value: pricing.itemDiscountValue,
      item_discount_amount: pricing.itemDiscountAmount,
      final_unit_price: pricing.finalUnitPrice,
      line_subtotal: roundMoney(pricing.finalUnitPrice * quantity),
      unit_net_profit: roundMoney(product.net_profit || 0),
    });
  }

  // Aggregate total quantity demanded per unique product+variant combination
  // (same variant may appear with different item discounts as separate cart rows).
  const stockDemand = new Map();
  for (const item of lineItems) {
    const key = `${item.product_id}:${item.variant_id || "simple"}`;
    stockDemand.set(key, (stockDemand.get(key) || 0) + item.quantity);
  }

  // Check stock once per unique key against the total aggregated demand.
  const checkedKeys = new Set();
  for (const item of lineItems) {
    const key = `${item.product_id}:${item.variant_id || "simple"}`;
    if (checkedKeys.has(key)) continue;
    checkedKeys.add(key);

    const totalQty = stockDemand.get(key);
    const product = productsById.get(item.product_id);
    const variant = item.variant_id ? variantsById.get(item.variant_id) : null;
    const availableStock = variant ? variant.stock : product.stock;
    if (availableStock < totalQty) {
      const error = new Error(`Insufficient stock for "${item.product_name}".`);
      error.status = 400;
      throw error;
    }
  }

  return lineItems;
}

export async function createPosSale({ cashierId, items, cartDiscountType, cartDiscountValue }) {
  if (!items?.length) {
    const error = new Error("Cart is empty.");
    error.status = 400;
    throw error;
  }

  let posSaleId;
  const connection = await db.getConnection();
  try {
    await ensurePosSchema();
    await ensureFinancialColumns(connection);
    await connection.beginTransaction();

    const lineItems = await buildSaleLineItems(connection, items);
    const totals = calculateCartTotals(lineItems, cartDiscountType, cartDiscountValue);
    const receiptNumber = await generateReceiptNumber(connection, "sale");

    const [saleResult] = await connection.query(
      `
        INSERT INTO pos_sales (
          receipt_number, transaction_type, cashier_id,
          subtotal_before_discount, items_discount_total,
          cart_discount_type, cart_discount_value, cart_discount_amount,
          final_total, total_net_profit, payment_method, items_count
        ) VALUES (?, 'sale', ?, ?, ?, ?, ?, ?, ?, ?, 'cash', ?)
      `,
      [
        receiptNumber,
        cashierId,
        totals.subtotalBeforeDiscount,
        totals.itemsDiscountTotal,
        totals.cartDiscountType,
        totals.cartDiscountValue,
        totals.cartDiscountAmount,
        totals.finalTotal,
        totals.totalNetProfit,
        totals.itemsCount,
      ],
    );

    posSaleId = saleResult.insertId;

    for (const item of lineItems) {
      await connection.query(
        `
          INSERT INTO pos_sale_items (
            pos_sale_id, product_id, variant_id, product_name,
            selected_size, selected_color_name, selected_color_value, selected_image_url,
            quantity, original_unit_price,
            item_discount_type, item_discount_value, item_discount_amount,
            final_unit_price, line_subtotal, unit_net_profit
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          posSaleId,
          item.product_id,
          item.variant_id,
          item.product_name,
          item.selected_size,
          item.selected_color_name,
          item.selected_color_value,
          item.selected_image_url,
          item.quantity,
          item.original_unit_price,
          item.item_discount_type,
          item.item_discount_value,
          item.item_discount_amount,
          item.final_unit_price,
          item.line_subtotal,
          item.unit_net_profit,
        ],
      );
    }

    const stockItems = lineItems.map((item) => ({
      product_id: item.product_id,
      variant_id: item.variant_id,
      quantity: item.quantity,
    }));

    await deductStockItems(connection, stockItems);
    await logInventoryMovements(connection, {
      items: stockItems.map((item) => ({
        ...item,
        quantity_delta: -item.quantity,
      })),
      reason: "pos_sale",
      referenceType: "pos_sale",
      referenceId: posSaleId,
      createdBy: cashierId,
    });

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  // Fetch outside the transaction so a fetch failure never triggers rollback
  // on an already-committed sale.
  return getPosSaleById(posSaleId);
}

export async function createPosReturn({ cashierId, receiptNumber, items }) {
  if (!receiptNumber?.trim()) {
    const error = new Error("Receipt number is required.");
    error.status = 400;
    throw error;
  }

  if (!items?.length) {
    const error = new Error("Select at least one item to return.");
    error.status = 400;
    throw error;
  }

  let returnSaleId;
  const connection = await db.getConnection();
  try {
    await ensurePosSchema();
    await connection.beginTransaction();

    const [originalSales] = await connection.query(
      `
        SELECT *
        FROM pos_sales
        WHERE receipt_number = ? AND transaction_type = 'sale'
        LIMIT 1
        FOR UPDATE
      `,
      [receiptNumber.trim()],
    );

    const originalSale = originalSales[0];
    if (!originalSale) {
      const error = new Error("Original sale receipt not found.");
      error.status = 404;
      throw error;
    }

    if (originalSale.transaction_type !== "sale") {
      const error = new Error("Returns can only be processed against a sale receipt.");
      error.status = 400;
      throw error;
    }

    const [originalItems] = await connection.query(
      `
        SELECT *
        FROM pos_sale_items
        WHERE pos_sale_id = ?
        FOR UPDATE
      `,
      [originalSale.id],
    );

    const originalItemsById = new Map(originalItems.map((row) => [row.id, row]));
    const returnLineItems = [];

    const originalItemsSubtotal = roundMoney(
      originalItems.reduce((sum, row) => sum + Number(row.line_subtotal), 0),
    );
    const originalCartDiscount = roundMoney(Number(originalSale.cart_discount_amount || 0));
    const cartDiscountRatio =
      originalItemsSubtotal > 0 && originalCartDiscount > 0
        ? originalCartDiscount / originalItemsSubtotal
        : 0;

    for (const raw of items) {
      const saleItemId = Number(raw.pos_sale_item_id);
      const returnQty = Number.parseInt(raw.quantity, 10) || 0;

      if (!saleItemId || returnQty < 1) {
        const error = new Error("Invalid return item.");
        error.status = 400;
        throw error;
      }

      const originalItem = originalItemsById.get(saleItemId);
      if (!originalItem) {
        const error = new Error("Sale item not found on original receipt.");
        error.status = 400;
        throw error;
      }

      const remainingQty =
        originalItem.quantity - Number(originalItem.returned_quantity || 0);
      if (returnQty > remainingQty) {
        const error = new Error(
          `Cannot return ${returnQty} unit(s) of "${originalItem.product_name}". Only ${remainingQty} remaining.`,
        );
        error.status = 400;
        throw error;
      }

      const grossLineSubtotal = roundMoney(originalItem.final_unit_price * returnQty);
      const cartDiscountShare = roundMoney(grossLineSubtotal * cartDiscountRatio);
      const netLineSubtotal = roundMoney(Math.max(grossLineSubtotal - cartDiscountShare, 0));

      returnLineItems.push({
        ...originalItem,
        quantity: returnQty,
        line_subtotal: netLineSubtotal,
        unit_net_profit: roundMoney(originalItem.unit_net_profit),
      });
    }

    const totals = calculateCartTotals(returnLineItems, "none", 0);
    const returnReceiptNumber = await generateReceiptNumber(connection, "return");

    const [returnResult] = await connection.query(
      `
        INSERT INTO pos_sales (
          receipt_number, transaction_type, original_sale_id, cashier_id,
          subtotal_before_discount, items_discount_total,
          cart_discount_type, cart_discount_value, cart_discount_amount,
          final_total, total_net_profit, payment_method, items_count
        ) VALUES (?, 'return', ?, ?, ?, ?, 'none', 0, ?, ?, ?, 'cash', ?)
      `,
      [
        returnReceiptNumber,
        originalSale.id,
        cashierId,
        totals.subtotalBeforeDiscount,
        totals.itemsDiscountTotal,
        roundMoney(
          returnLineItems.reduce((sum, item) => {
            const gross = item.final_unit_price * item.quantity;
            return sum + (gross - item.line_subtotal);
          }, 0),
        ),
        totals.finalTotal,
        -Math.abs(totals.totalNetProfit),
        totals.itemsCount,
      ],
    );

    returnSaleId = returnResult.insertId;

    for (const item of returnLineItems) {
      await connection.query(
        `
          INSERT INTO pos_sale_items (
            pos_sale_id, product_id, variant_id, product_name,
            selected_size, selected_color_name, selected_color_value, selected_image_url,
            quantity, original_unit_price,
            item_discount_type, item_discount_value, item_discount_amount,
            final_unit_price, line_subtotal, unit_net_profit
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          returnSaleId,
          item.product_id,
          item.variant_id,
          item.product_name,
          item.selected_size,
          item.selected_color_name,
          item.selected_color_value,
          item.selected_image_url,
          item.quantity,
          item.original_unit_price,
          item.item_discount_type,
          item.item_discount_value,
          item.item_discount_amount,
          item.final_unit_price,
          item.line_subtotal,
          item.unit_net_profit,
        ],
      );

      await connection.query(
        `
          UPDATE pos_sale_items
          SET returned_quantity = returned_quantity + ?
          WHERE id = ?
        `,
        [item.quantity, item.id],
      );
    }

    const stockItems = returnLineItems.map((item) => ({
      product_id: item.product_id,
      variant_id: item.variant_id,
      quantity: item.quantity,
    }));

    await restoreStockItems(connection, stockItems);
    await logInventoryMovements(connection, {
      items: stockItems.map((item) => ({
        ...item,
        quantity_delta: item.quantity,
      })),
      reason: "pos_return",
      referenceType: "pos_sale",
      referenceId: returnSaleId,
      createdBy: cashierId,
    });

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  // Fetch outside the transaction so a fetch failure never triggers rollback
  // on an already-committed return.
  return getPosSaleById(returnSaleId);
}

export async function getPosSaleById(id) {
  await ensurePosSchema();

  const [sales] = await db.query(
    `
      SELECT ps.*, u.name AS cashier_name
      FROM pos_sales ps
      LEFT JOIN users u ON u.id = ps.cashier_id
      WHERE ps.id = ?
    `,
    [id],
  );

  if (!sales.length) return null;

  const sale = sales[0];
  const [items] = await db.query(
    "SELECT * FROM pos_sale_items WHERE pos_sale_id = ? ORDER BY id ASC",
    [id],
  );

  sale.items = items;
  return sale;
}

export async function getPosSaleByReceiptNumber(receiptNumber) {
  await ensurePosSchema();

  const [sales] = await db.query(
    `
      SELECT ps.*, u.name AS cashier_name
      FROM pos_sales ps
      LEFT JOIN users u ON u.id = ps.cashier_id
      WHERE ps.receipt_number = ?
    `,
    [receiptNumber.trim()],
  );

  if (!sales.length) return null;

  const sale = sales[0];
  const [items] = await db.query(
    "SELECT * FROM pos_sale_items WHERE pos_sale_id = ? ORDER BY id ASC",
    [sale.id],
  );

  sale.items = items.map((item) => ({
    ...item,
    returnable_quantity: item.quantity - Number(item.returned_quantity || 0),
  }));

  return sale;
}

export async function listPosSales({ page = 1, limit = 20, search = "", dateFrom = "", dateTo = "" }) {
  await ensurePosSchema();

  const offset = (page - 1) * limit;
  const conditions = ["1=1"];
  const params = [];

  if (search.trim()) {
    conditions.push("ps.receipt_number LIKE ?");
    params.push(`%${search.trim()}%`);
  }

  if (dateFrom) {
    conditions.push("DATE(ps.created_at) >= ?");
    params.push(dateFrom);
  }

  if (dateTo) {
    conditions.push("DATE(ps.created_at) <= ?");
    params.push(dateTo);
  }

  const whereClause = conditions.join(" AND ");

  const [[countRow]] = await db.query(
    `SELECT COUNT(*) AS total FROM pos_sales ps WHERE ${whereClause}`,
    params,
  );

  const [rows] = await db.query(
    `
      SELECT ps.*, u.name AS cashier_name
      FROM pos_sales ps
      LEFT JOIN users u ON u.id = ps.cashier_id
      WHERE ${whereClause}
      ORDER BY ps.created_at DESC, ps.id DESC
      LIMIT ? OFFSET ?
    `,
    [...params, limit, offset],
  );

  return {
    sales: rows,
    pagination: {
      total: countRow.total,
      page,
      limit,
      pages: Math.ceil(countRow.total / limit) || 1,
    },
  };
}

export async function getProductByBarcode(barcode) {
  await ensurePosSchema();
  await ensureFinancialColumns();

  const [rows] = await db.query(
    `
      SELECT products.*, categories.name AS category_name
      FROM products
      LEFT JOIN categories ON categories.id = products.category_id
      WHERE products.barcode = ? AND products.is_active = 1
      LIMIT 1
    `,
    [barcode.trim()],
  );

  if (!rows.length) return null;

  const product = rows[0];

  const [colors] = await db.query(
    `
      SELECT pc.id, pc.name, pc.value, pc.sort_order,
             (
               SELECT pci.image_url
               FROM product_color_images pci
               WHERE pci.product_color_id = pc.id
               ORDER BY pci.is_main DESC, pci.id ASC
               LIMIT 1
             ) AS image_url
      FROM product_colors pc
      WHERE pc.product_id = ?
      ORDER BY pc.sort_order ASC, pc.id ASC
    `,
    [product.id],
  );

  const [variants] = await db.query(
    `
      SELECT pv.id, pv.product_id, pv.product_color_id, pv.size_value, pv.stock,
             pc.name AS color_name, pc.value AS color_value
      FROM product_variants pv
      LEFT JOIN product_colors pc ON pc.id = pv.product_color_id
      WHERE pv.product_id = ?
      ORDER BY pv.id ASC
    `,
    [product.id],
  );

  const [images] = await db.query(
    `
      SELECT image_url, is_main
      FROM product_images
      WHERE product_id = ?
      ORDER BY is_main DESC, id ASC
    `,
    [product.id],
  );

  product.colors = colors;
  product.variants = variants;
  product.images = images;

  if (!variants.length) {
    product.variant_count = 0;
  } else {
    product.variant_count = variants.length;
  }

  return product;
}
