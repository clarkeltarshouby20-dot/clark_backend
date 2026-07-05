/**
 * @file orders.controllers.js
 * @description Centralized business logic for processing and managing orders.
 *
 * This controller handles one of the most critical flows in the application: Checkout.
 * 
 * Key architectural features:
 *  - TRANSACTIONS: `createOrder` and `updateOrderStatus` use strict MySQL Transactions (`connection.beginTransaction()`).
 *    This ensures that payment validation, stock deduction, and order creation are ATOMIC (all succeed or all fail).
 *  - STOCK DEDUCTION: Stock is deducted instantly upon order creation via `deductOrderItemStock`.
 *  - CONCURRENCY CONTROL: `SELECT ... FOR UPDATE` is used heavily in `createOrder` to lock 
 *    the product/variant rows, preventing race conditions where two users buy the last item at the exact same millisecond.
 *  - FINANCIAL SNAPSHOTS: Net profit and prices are snapshot copied into `order_items`. 
 *    If the admin changes a product's price later, the past order's historical records won't break.
 */

import db from "../config/db.js";
import {
  deductOrderItemStock,
  restoreOrderItemStock,
} from "../utils/variantStock.js";
import { normalizeGovernorates } from "../utils/egyptGovernorates.js";
import { ensureFinancialColumns } from "../utils/financialSchema.js";

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function buildOrderItemsSelect() {
  return `
    SELECT
      oi.id,
      oi.order_id,
      oi.product_id,
      oi.variant_id,
      oi.quantity,
      oi.price,
      oi.unit_net_profit,
      oi.selected_size,
      oi.selected_color_name,
      oi.selected_color_value,
      oi.selected_image_url,
      p.name AS product_name,
      p.name_ar AS product_name_ar,
      COALESCE(
        oi.selected_image_url,
        (SELECT pi.image_url FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.is_main DESC, pi.id ASC LIMIT 1)
      ) AS main_image
    FROM order_items oi
    LEFT JOIN products p ON oi.product_id = p.id
  `;
}

async function getShippingGovernorates(connection) {
  const [rows] = await connection.query(
    "SELECT shipping_governorates FROM site_settings LIMIT 1",
  );
  return normalizeGovernorates(rows[0]?.shipping_governorates);
}

function parseGovernorateKey(value) {
  const raw = String(value || "").trim();
  const parts = raw
    .split("/")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);

  return {
    raw: raw.toLowerCase(),
    en: parts[0] || raw.toLowerCase(),
    ar: parts[1] || raw.toLowerCase(),
  };
}

function normalizeGovernorateToken(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&amp;#x2f;|&#x2f;/gi, "/")
    .replace(/[\/\\|،,:;-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function governorateMatches(candidateValue, requestedValue) {
  const candidate = parseGovernorateKey(candidateValue);
  const requested = parseGovernorateKey(requestedValue);

  const candidateTokens = [
    candidate.raw,
    candidate.en,
    candidate.ar,
    ...candidate.raw.split("/"),
  ]
    .map(normalizeGovernorateToken)
    .filter(Boolean);

  const requestedTokens = [
    requested.raw,
    requested.en,
    requested.ar,
    ...requested.raw.split("/"),
  ]
    .map(normalizeGovernorateToken)
    .filter(Boolean);

  return requestedTokens.some((requestedToken) =>
    candidateTokens.some(
      (candidateToken) =>
        candidateToken === requestedToken ||
        candidateToken.includes(requestedToken) ||
        requestedToken.includes(candidateToken),
    ),
  );
}

async function attachOrderItems(connection, orders) {
  if (!orders.length) return;

  const orderIds = orders.map((order) => order.id);
  const [items] = await connection.query(
    `
      ${buildOrderItemsSelect()}
      WHERE oi.order_id IN (?)
      ORDER BY oi.id ASC
    `,
    [orderIds],
  );

  const itemsByOrder = items.reduce((accumulator, item) => {
    if (!accumulator[item.order_id]) {
      accumulator[item.order_id] = [];
    }
    accumulator[item.order_id].push(item);
    return accumulator;
  }, {});

  orders.forEach((order) => {
    order.items = itemsByOrder[order.id] || [];
  });
}

/**
 * GET /api/orders
 * 
 * Admin endpoint to list all orders globally across the platform.
 * Supports pagination, text search (by ID, email, name), and status filtering.
 *
 * @route   GET /api/orders
 * @access  Protected (Admin/Owner only)
 */
export const getAllOrders = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const offset = (page - 1) * limit;

    const search = req.query.search || "";
    const status = req.query.status || "";

    let whereSql = "1=1";
    const queryParams = [];

    if (status) {
      whereSql += " AND o.status = ?";
      queryParams.push(status);
    }

    if (search) {
      whereSql += " AND (u.name LIKE ? OR u.email LIKE ? OR o.id = ?)";
      const searchLike = `%${search}%`;
      const searchId = Number.isNaN(Number(search)) ? 0 : parseInt(search, 10);
      queryParams.push(searchLike, searchLike, searchId);
    }

    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total FROM orders o LEFT JOIN users u ON o.user_id = u.id WHERE ${whereSql}`,
      queryParams,
    );

    const [orders] = await db.query(
      `
        SELECT
          o.id,
          o.status,
          o.payment_status,
          o.payment_method,
          o.payment_receipt_url,
          o.transaction_id,
          o.total_price,
          o.items_total,
          o.discount_amount,
          o.shipping_fee,
          o.return_reason,
          o.created_at,
          o.shipping_full_name,
          o.shipping_governorate,
          o.shipping_phone,
          o.shipping_address,
          u.name,
          u.email,
          u.phone
        FROM orders o
        LEFT JOIN users u ON o.user_id = u.id
        WHERE ${whereSql}
        ORDER BY o.created_at DESC
        LIMIT ? OFFSET ?
      `,
      [...queryParams, limit, offset],
    );

    await attachOrderItems(db, orders);

    res.status(200).json({
      success: true,
      message: "Orders retrieved successfully",
      data: orders,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/orders/me
 * 
 * Fetches the paginated order history for the currently logged-in user.
 *
 * @route   GET /api/orders/me
 * @access  Protected (User only)
 */
export const getUserOrders = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const offset = (page - 1) * limit;

    const [[{ total }]] = await db.query(
      "SELECT COUNT(*) AS total FROM orders WHERE user_id = ?",
      [userId],
    );

    const [orders] = await db.query(
      `
        SELECT
          id,
          status,
          payment_status,
          payment_method,
          total_price,
          items_total,
          discount_amount,
          shipping_fee,
          return_reason,
          created_at,
          rejection_reason,
          shipping_full_name,
          shipping_governorate,
          shipping_phone,
          shipping_address
        FROM orders
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `,
      [userId, limit, offset],
    );

    await attachOrderItems(db, orders);

    res.status(200).json({
      success: true,
      message: "Your orders retrieved successfully",
      data: orders,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/orders/:id
 * 
 * Fetches full details for a single order containing its items and status.
 * Access is restricted: regular users can only fetch their own orders, 
 * while Admins can fetch any order ID.
 *
 * @route   GET /api/orders/:id
 * @access  Protected (Owner of order OR Admin)
 */
export const getOrderById = async (req, res, next) => {
  try {
    const orderId = req.params.id;
    const userId = req.user.id;
    const isAdmin = req.user.role === "admin" || req.user.role === "owner";

    let query = `
      SELECT
        o.id,
        o.status,
        o.payment_status,
        o.payment_method,
        o.total_price,
        o.items_total,
        o.discount_amount,
        o.shipping_fee,
        o.return_reason,
        o.created_at,
        o.rejection_reason,
        o.payment_receipt_url,
        o.shipping_full_name,
        o.shipping_governorate,
        o.shipping_phone,
        o.shipping_address,
        u.name,
        u.email
      FROM orders o
      LEFT JOIN users u ON o.user_id = u.id
      WHERE o.id = ?
    `;

    const params = [orderId];
    if (!isAdmin) {
      query += " AND o.user_id = ?";
      params.push(userId);
    }

    const [[order]] = await db.query(query, params);
    if (!order) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    await attachOrderItems(db, [order]);

    res.status(200).json({
      success: true,
      data: order,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/orders
 * 
 * Massive, critical endpoint that processes user checkout.
 * 
 * Execution Flow:
 *  1. Validation: Address, phone number, empty carts.
 *  2. Lock Creation: Starts a DB Transaction -> Locks the requested Products/Variants (`FOR UPDATE`).
 *  3. Stock Verification: Cross-checks cart quantities vs hard locked database stock.
 *  4. Coupon Handling: Applies promo codes and limits.
 *  5. Order Row Insertion: Mints the main `orders` row.
 *  6. Order Items Insertion: Batch inserts into `order_items` (copying price and profit snapshots).
 *  7. Stock Deduction: Fires the variantStock util to instantly reserve the actual physical stock.
 *  8. Commit Transaction -> Success.
 *
 * @route   POST /api/orders
 * @access  Protected (User only)
 */
export const createOrder = async (req, res, next) => {
  const connection = await db.getConnection();
  try {
    await ensureFinancialColumns(connection);

    const userId = req.user.id;
    let {
      items,
      payment_method,
      reference,
      full_name,
      shipping_governorate,
      shipping_phone,
      shipping_address,
      coupon_code,
    } = req.body || {};

    items = parseJsonArray(items);

    if (!items.length) {
      return res.status(400).json({ success: false, message: "Cart is empty" });
    }

    if (!shipping_phone || !/^01[0125][0-9]{8}$/.test(shipping_phone)) {
      return res.status(400).json({
        success: false,
        message:
          "A valid Egyptian phone number is required (e.g., 01012345678).",
      });
    }

    if (!shipping_address || shipping_address.trim().length < 5) {
      return res.status(400).json({
        success: false,
        message: "A valid shipping address is required.",
      });
    }

    if (!full_name || String(full_name).trim().length < 2) {
      return res.status(400).json({
        success: false,
        message: "A valid recipient name is required.",
      });
    }

    const validatedPaymentMethod = ["wallet", "instapay", "cod"].includes(
      payment_method,
    )
      ? payment_method
      : "wallet";

    if (
      ["wallet", "instapay"].includes(validatedPaymentMethod) &&
      !req.file
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Receipt screenshot is required for Electronic Wallet and InstaPay payments.",
      });
    }

    await connection.beginTransaction();

    const normalizedItems = items.map((item) => ({
      id: Number(item.id),
      variant_id: item.variant_id ? Number(item.variant_id) : null,
      quantity: Number(item.quantity),
      selected_size:
        item.selected_size !== undefined && item.selected_size !== null
          ? String(item.selected_size)
          : null,
      selected_color_name:
        item.selected_color_name !== undefined && item.selected_color_name !== null
          ? String(item.selected_color_name)
          : null,
      selected_color_value:
        item.selected_color_value !== undefined &&
        item.selected_color_value !== null
          ? String(item.selected_color_value)
          : null,
      selected_image:
        item.selected_image !== undefined && item.selected_image !== null
          ? String(item.selected_image)
          : null,
    }));

    if (
      normalizedItems.some(
        (item) =>
          !Number.isInteger(item.id) ||
          item.id <= 0 ||
          !Number.isInteger(item.quantity) ||
          item.quantity <= 0,
      )
    ) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: "Order items are invalid.",
      });
    }

    const uniqueProductIds = [
      ...new Set(normalizedItems.map((item) => item.id)),
    ];
    const uniqueVariantIds = [
      ...new Set(
        normalizedItems
          .map((item) => item.variant_id)
          .filter((variantId) => Number.isInteger(variantId) && variantId > 0),
      ),
    ];

    const [productRows] = await connection.query(
      `
        SELECT
          p.id,
          p.name,
          p.price,
          p.net_profit,
          p.stock,
          p.is_active,
          p.size_mode,
          EXISTS(
            SELECT 1 FROM product_variants pv WHERE pv.product_id = p.id
          ) AS has_variants,
          COALESCE(
            (SELECT pi.image_url
             FROM product_images pi
             WHERE pi.product_id = p.id
             ORDER BY pi.is_main DESC, pi.id ASC
             LIMIT 1),
            NULL
          ) AS main_image
        FROM products p
        WHERE p.id IN (?) FOR UPDATE
      `,
      [uniqueProductIds],
    );

    if (productRows.length !== uniqueProductIds.length) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: "One or more products no longer exist.",
      });
    }

    const [variantRows] = uniqueVariantIds.length
      ? await connection.query(
          `
            SELECT
              pv.id,
              pv.product_id,
              pv.product_color_id,
              pv.size_value,
              pv.stock,
              pc.name AS color_name,
              pc.value AS color_value,
              COALESCE(
                (SELECT pci.image_url
                 FROM product_color_images pci
                 WHERE pci.product_color_id = pc.id
                 ORDER BY pci.is_main DESC, pci.sort_order ASC, pci.id ASC
                 LIMIT 1),
                (SELECT pi.image_url
                 FROM product_images pi
                 WHERE pi.product_id = pv.product_id
                 ORDER BY pi.is_main DESC, pi.id ASC
                 LIMIT 1)
              ) AS image_url
            FROM product_variants pv
            LEFT JOIN product_colors pc ON pc.id = pv.product_color_id
            WHERE pv.id IN (?) FOR UPDATE
          `,
          [uniqueVariantIds],
        )
      : [[]];

    if (variantRows.length !== uniqueVariantIds.length) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: "One or more selected variants no longer exist.",
      });
    }

    const productsById = new Map(productRows.map((product) => [product.id, product]));
    const variantsById = new Map(variantRows.map((variant) => [variant.id, variant]));

    const requestedStockByKey = new Map();
    for (const item of normalizedItems) {
      const stockKey = item.variant_id
        ? `variant:${item.variant_id}`
        : `product:${item.id}`;
      requestedStockByKey.set(
        stockKey,
        (requestedStockByKey.get(stockKey) || 0) + item.quantity,
      );
    }

    const canonicalItems = normalizedItems.map((item) => {
      const product = productsById.get(item.id);

      if (!product || !product.is_active) {
        throw new Error(
          `${product?.name || "This product"} is currently unavailable.`,
        );
      }

      if (product.has_variants && !item.variant_id) {
        throw new Error(`Please choose a valid color and size for ${product.name}.`);
      }

      if (!product.has_variants && item.variant_id) {
        throw new Error(`${product.name} no longer requires a variant selection.`);
      }

      if (!item.variant_id) {
        const requestedStock = requestedStockByKey.get(`product:${item.id}`) || 0;
        if (requestedStock > Number(product.stock)) {
          throw new Error(
            `Only ${product.stock} unit(s) available for ${product.name}.`,
          );
        }

        return {
          product_id: item.id,
          variant_id: null,
          quantity: item.quantity,
          price: Number(product.price),
          unit_net_profit: Number(product.net_profit || 0),
          name: product.name,
          selected_size: null,
          selected_color_name: null,
          selected_color_value: null,
          selected_image_url: item.selected_image || product.main_image || null,
        };
      }

      const variant = variantsById.get(item.variant_id);
      if (!variant || variant.product_id !== item.id) {
        throw new Error(`Selected variant for ${product.name} is invalid.`);
      }

      if (
        item.selected_size &&
        String(item.selected_size) !== String(variant.size_value || "")
      ) {
        throw new Error(`Selected size for ${product.name} is invalid.`);
      }

      if (
        item.selected_color_value &&
        String(item.selected_color_value).toLowerCase() !==
          String(variant.color_value || "").toLowerCase()
      ) {
        throw new Error(`Selected color for ${product.name} is invalid.`);
      }

      const requestedVariantStock =
        requestedStockByKey.get(`variant:${item.variant_id}`) || 0;
      if (requestedVariantStock > Number(variant.stock)) {
        throw new Error(
          `Only ${variant.stock} unit(s) available for the selected ${product.name} variant.`,
        );
      }

      return {
        product_id: item.id,
        variant_id: variant.id,
        quantity: item.quantity,
        price: Number(product.price),
        unit_net_profit: Number(product.net_profit || 0),
        name: product.name,
        selected_size: variant.size_value,
        selected_color_name: variant.color_name,
        selected_color_value: variant.color_value,
        selected_image_url: variant.image_url || item.selected_image || product.main_image || null,
      };
    });

    const itemsTotal = canonicalItems.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0,
    );
    let finalTotalPrice = itemsTotal;
    let validatedCouponCode = null;
    let discountAmount = 0;

    if (coupon_code) {
      const [couponRows] = await connection.query(
        "SELECT * FROM coupons WHERE code = ? AND is_active = 1 FOR UPDATE",
        [String(coupon_code).toUpperCase()],
      );

      if (!couponRows.length) {
        await connection.rollback();
        return res
          .status(400)
          .json({ success: false, message: "Invalid coupon code" });
      }

      const coupon = couponRows[0];
      const now = new Date();
      const isExpired =
        coupon.expiry_date && new Date(coupon.expiry_date) < now;
      const reachedLimit =
        coupon.max_uses !== null && coupon.used_count >= coupon.max_uses;

      if (
        isExpired ||
        reachedLimit ||
        finalTotalPrice < Number(coupon.min_order_amount || 0)
      ) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: "Applied coupon is no longer valid",
        });
      }

      let discount = 0;
      if (coupon.discount_type === "percentage") {
        discount = (finalTotalPrice * Number(coupon.discount_value || 0)) / 100;
      } else {
        discount = Math.min(Number(coupon.discount_value || 0), finalTotalPrice);
      }

      discountAmount = discount;
      finalTotalPrice = Math.max(0, finalTotalPrice - discount);
      validatedCouponCode = coupon.code;

      await connection.query(
        "UPDATE coupons SET used_count = used_count + 1 WHERE id = ?",
        [coupon.id],
      );
    }

    const shippingOptions = await getShippingGovernorates(connection);
    const normalizedGovernorate = String(shipping_governorate || "").trim();
    const selectedGovernorate = shippingOptions.find(
      (item) => item.is_active && governorateMatches(item.key, normalizedGovernorate),
    );

    if (!selectedGovernorate) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: "Please choose an available shipping governorate.",
      });
    }

    const shippingFee = Number(selectedGovernorate.value || 0);
    finalTotalPrice += shippingFee;

    const receiptUrl = req.file ? req.file.path : null;
    const paymentStatus =
      validatedPaymentMethod === "cod" ? "unpaid" : "pending_verification";

    const [orderResult] = await connection.query(
      `
        INSERT INTO orders (
          user_id,
          total_price,
          items_total,
          discount_amount,
          coupon_code,
          status,
          payment_status,
          payment_method,
          payment_receipt_url,
          transaction_id,
          shipping_full_name,
          shipping_governorate,
          shipping_fee,
          inventory_reserved,
          shipping_phone,
          shipping_address
        )
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `,
      [
        userId,
        finalTotalPrice,
        itemsTotal,
        discountAmount,
        validatedCouponCode,
        paymentStatus,
        validatedPaymentMethod,
        receiptUrl,
        reference || null,
        String(full_name).trim(),
        selectedGovernorate.key,
        shippingFee,
        shipping_phone,
        shipping_address,
      ],
    );

    const orderId = orderResult.insertId;
    const orderItemsValues = canonicalItems.map((item) => [
      orderId,
      item.product_id,
      item.variant_id,
      item.price,
      item.unit_net_profit,
      item.quantity,
      item.selected_size,
      item.selected_color_name,
      item.selected_color_value,
      item.selected_image_url,
    ]);

    await connection.query(
      `
        INSERT INTO order_items (
          order_id,
          product_id,
          variant_id,
          price,
          unit_net_profit,
          quantity,
          selected_size,
          selected_color_name,
          selected_color_value,
          selected_image_url
        ) VALUES ?
      `,
      [orderItemsValues],
    );

    // Reserve/deduct stock immediately once the order is created.
    await deductOrderItemStock(connection, orderId);

    await connection.commit();

    res.status(201).json({
      success: true,
      message: "Order placed successfully",
      data: { order_id: orderId },
    });
  } catch (error) {
    await connection.rollback();
    if (error.message) {
      return res.status(400).json({ success: false, message: error.message });
    }
    next(error);
  } finally {
    connection.release();
  }
};

/**
 * PUT /api/orders/:id/status
 * 
 * Allows an admin to push an order through its fulfilment lifecycle.
 * E.g., 'pending' -> 'verified' -> 'shipped' -> 'delivered'.
 * 
 * Reversal Logic:
 *  If an order is moved to 'cancelled', 'rejected', or 'returned',
 *  this endpoint triggers an atomic `restoreOrderItemStock` to return the 
 *  items back to the physical warehouse stock.
 *
 * @route   PUT /api/orders/:id/status
 * @access  Protected (Admin/Owner only)
 */
export const updateOrderStatus = async (req, res, next) => {
  const connection = await db.getConnection();
  try {
    await ensureFinancialColumns(connection);

    const orderId = req.params.id;
    const { status } = req.body;
    const validStatuses = [
      "pending",
      "confirmed",
      "verified",
      "shipped",
      "out_for_delivery",
      "delivered",
      "cancelled",
      "rejected",
      "returned",
      "problem",
    ];

    if (!validStatuses.includes(status)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid status" });
    }

    await connection.beginTransaction();

    const [[currentOrder]] = await connection.query(
      "SELECT status, payment_status, inventory_reserved FROM orders WHERE id = ? FOR UPDATE",
      [orderId],
    );

    if (!currentOrder) {
      await connection.rollback();
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    const isNowReversingInventory = ["cancelled", "rejected", "returned"].includes(
      status,
    );
    const wasStockReserved = Boolean(Number(currentOrder.inventory_reserved || 0));
    const terminalStatuses = ["cancelled", "rejected", "returned"];

    if (
      terminalStatuses.includes(currentOrder.status) &&
      !terminalStatuses.includes(status)
    ) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message:
          "This order is closed and cannot be moved back to an active status.",
      });
    }

    if (status === currentOrder.status) {
      await connection.rollback();
      return res.status(200).json({
        success: true,
        message: `Order is already ${status}.`,
      });
    }

    if (status === "returned" && currentOrder.status !== "delivered") {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message:
          currentOrder.status === "returned"
            ? "This order has already been returned."
            : "Only delivered orders can be returned.",
      });
    }

    if (isNowReversingInventory && wasStockReserved) {
      await restoreOrderItemStock(connection, orderId);
    }

    const nextPaymentStatus =
      ["cancelled", "rejected"].includes(status) &&
      currentOrder.status !== "cancelled"
        ? "rejected"
        : status === "delivered"
          ? "paid"
          : undefined;

    const nextInventoryReserved = isNowReversingInventory
      ? 0
      : currentOrder.inventory_reserved;

    await connection.query(
      `
        UPDATE orders
        SET
          status = ?,
          rejection_reason = ?,
          return_reason = ?,
          inventory_reserved = ?,
          payment_status = COALESCE(?, payment_status)
        WHERE id = ?
      `,
      [
        status,
        status === "rejected" ? req.body.reason || null : null,
        status === "returned" ? req.body.reason || null : null,
        nextInventoryReserved,
        nextPaymentStatus ?? null,
        orderId,
      ],
    );

    await connection.commit();

    res.status(200).json({
      success: true,
      message:
        status === "rejected"
          ? "Order has been successfully rejected"
          : `Order status updated to ${status}`,
    });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
};
