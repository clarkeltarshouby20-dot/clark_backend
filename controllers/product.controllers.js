/**
 * @file product.controllers.js
 * @description Master controller for Products architecture and inventory configurations.
 *
 * This controller manages the extremely complex creation and structuring of dynamic products.
 * Products can be either "Simple" (just a price and stock) or "Complex" (having variants like Colors and Sizes).
 * 
 * Variant Architecture (The Matrix):
 *  If a product has Colors [Red, Blue] and Sizes [M, L], it generates a matrix of `product_variants`:
 *   - Red / M (Stock: 10)
 *   - Red / L (Stock: 5)
 *   - Blue / M (Stock: 0)
 *   - Blue / L (Stock: 20)
 * 
 * Image Management:
 *  - Colors can have their own dedicated image galleries (`product_color_images`)
 *  - If no colors exist, standard flat images are used (`product_images`)
 *
 * The heavy lifting (inserting/updating across 4 different database tables simultaneously)
 * is handled securely inside an atomic transaction within `saveProductRecord()`.
 */

import db from "../config/db.js";
import slugify from "slugify";
import jwt from "jsonwebtoken";
import { expandQuery } from "../utils/searchHelper.js";
import { ensureFinancialColumns } from "../utils/financialSchema.js";
import { ensurePosSchema } from "../utils/posSchema.js";
import { assignBarcodeToProduct } from "../services/posBarcodeService.js";

const ALPHA_SIZES = ["S", "M", "L", "XL", "XXL", "XXXL"];
const NUMERIC_SIZES = Array.from({ length: 21 }, (_, index) =>
  String(index + 30),
);

const COLOR_FIELD_PREFIX = "color_images:";

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

function normalizeSizeMode(mode) {
  return ["none", "alpha", "numeric"].includes(mode) ? mode : "none";
}

function normalizeSizeOptions(sizeMode, rawSizes) {
  if (sizeMode === "none") return [];

  const allowedSizes = sizeMode === "alpha" ? ALPHA_SIZES : NUMERIC_SIZES;
  const uniqueSizes = [...new Set(parseJsonArray(rawSizes).map(String))];
  const filtered = uniqueSizes.filter((size) => allowedSizes.includes(size));

  return allowedSizes.filter((size) => filtered.includes(size));
}

function normalizeColors(rawColors) {
  const colors = parseJsonArray(rawColors);

  return colors
    .map((color, index) => ({
      id: color.id ? Number(color.id) : null,
      client_key:
        String(color.client_key || "").trim() ||
        (color.id ? `existing-${color.id}` : `color-${index}`),
      name: String(color.name || "").trim(),
      value: String(color.value || "").trim(),
      sort_order:
        color.sort_order !== undefined ? Number(color.sort_order) : index,
    }))
    .filter((color) => color.name && color.value);
}

function normalizeVariantStock(rawVariantStock) {
  return parseJsonArray(rawVariantStock).map((variant) => ({
    color_key: variant.color_key ? String(variant.color_key).trim() : null,
    size_value:
      variant.size_value !== undefined && variant.size_value !== null
        ? String(variant.size_value).trim()
        : null,
    stock: Number.parseInt(variant.stock, 10),
  }));
}

function getExpectedVariantCombos(colors, sizeOptions) {
  if (!colors.length && !sizeOptions.length) return [];
  if (colors.length && sizeOptions.length) {
    return colors.flatMap((color) =>
      sizeOptions.map((sizeValue) => ({
        color_key: color.client_key,
        size_value: sizeValue,
      })),
    );
  }
  if (colors.length) {
    return colors.map((color) => ({
      color_key: color.client_key,
      size_value: null,
    }));
  }
  return sizeOptions.map((sizeValue) => ({
    color_key: null,
    size_value: sizeValue,
  }));
}

function buildVariantComboKey(colorKey, sizeValue) {
  return `${colorKey || ""}::${sizeValue || ""}`;
}

function groupProductFiles(files = []) {
  const generalImages = [];
  const colorImages = new Map();

  for (const file of files || []) {
    const fieldName = String(file.fieldname || "");
    if (fieldName === "images" || fieldName === "images[]") {
      generalImages.push(file);
      continue;
    }

    if (fieldName.startsWith(COLOR_FIELD_PREFIX)) {
      const colorKey = fieldName.slice(COLOR_FIELD_PREFIX.length).replace(
        /\[\]$/,
        "",
      );
      if (!colorImages.has(colorKey)) {
        colorImages.set(colorKey, []);
      }
      colorImages.get(colorKey).push(file);
    }
  }

  return { generalImages, colorImages };
}

function validateHexColor(value) {
  return /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(value);
}

function deriveSizeOptions(variants, sizeMode) {
  if (sizeMode === "none") return [];
  const allowed = sizeMode === "alpha" ? ALPHA_SIZES : NUMERIC_SIZES;
  const selected = new Set(
    variants
      .map((variant) => variant.size_value)
      .filter((sizeValue) => sizeValue !== null && sizeValue !== undefined),
  );
  return allowed.filter((sizeValue) => selected.has(String(sizeValue)));
}

async function getProductsSupplementaryData(connection, productIds) {
  const ids = [...new Set((productIds || []).map(Number).filter(Boolean))];
  if (!ids.length) {
    return {
      imagesByProduct: new Map(),
      colorsByProduct: new Map(),
      variantsByProduct: new Map(),
    };
  }

  const [generalImages] = await connection.query(
    `
      SELECT id, product_id, image_url, is_main
      FROM product_images
      WHERE product_id IN (?)
      ORDER BY is_main DESC, id ASC
    `,
    [ids],
  );

  const [colors] = await connection.query(
    `
      SELECT id, product_id, name, value, sort_order
      FROM product_colors
      WHERE product_id IN (?)
      ORDER BY sort_order ASC, id ASC
    `,
    [ids],
  );

  const colorIds = colors.map((color) => color.id);
  const [colorImages] = colorIds.length
    ? await connection.query(
        `
          SELECT id, product_color_id, image_url, sort_order, is_main
          FROM product_color_images
          WHERE product_color_id IN (?)
          ORDER BY sort_order ASC, id ASC
        `,
        [colorIds],
      )
    : [[]];

  const [variants] = await connection.query(
    `
      SELECT id, product_id, product_color_id, size_value, stock
      FROM product_variants
      WHERE product_id IN (?)
      ORDER BY id ASC
    `,
    [ids],
  );

  const imagesByProduct = new Map();
  for (const image of generalImages) {
    if (!imagesByProduct.has(image.product_id)) {
      imagesByProduct.set(image.product_id, []);
    }
    imagesByProduct.get(image.product_id).push(image.image_url);
  }

  const colorImagesByColor = new Map();
  for (const image of colorImages) {
    if (!colorImagesByColor.has(image.product_color_id)) {
      colorImagesByColor.set(image.product_color_id, []);
    }
    colorImagesByColor.get(image.product_color_id).push(image.image_url);
  }

  const colorMetaById = new Map();
  const colorsByProduct = new Map();
  for (const color of colors) {
    const colorOption = {
      id: color.id,
      name: color.name,
      value: color.value,
      images: colorImagesByColor.get(color.id) || [],
      main_image: (colorImagesByColor.get(color.id) || [])[0] || null,
    };
    colorMetaById.set(color.id, colorOption);

    if (!colorsByProduct.has(color.product_id)) {
      colorsByProduct.set(color.product_id, []);
    }
    colorsByProduct.get(color.product_id).push(colorOption);
  }

  const variantsByProduct = new Map();
  for (const variant of variants) {
    const colorMeta = variant.product_color_id
      ? colorMetaById.get(variant.product_color_id)
      : null;
    const normalizedVariant = {
      id: variant.id,
      color_id: variant.product_color_id,
      color_name: colorMeta?.name || null,
      color_value: colorMeta?.value || null,
      color_main_image: colorMeta?.main_image || null,
      size_value: variant.size_value,
      stock: Number(variant.stock),
    };

    if (!variantsByProduct.has(variant.product_id)) {
      variantsByProduct.set(variant.product_id, []);
    }
    variantsByProduct.get(variant.product_id).push(normalizedVariant);
  }

  return { imagesByProduct, colorsByProduct, variantsByProduct };
}

function decorateProduct(product, supplementaryData) {
  const generalImages =
    supplementaryData.imagesByProduct.get(product.id) || [];
  const colorOptions =
    supplementaryData.colorsByProduct.get(product.id) || [];
  const variants = supplementaryData.variantsByProduct.get(product.id) || [];

  const stock = variants.length
    ? variants.reduce((sum, variant) => sum + Number(variant.stock || 0), 0)
    : Number(product.stock || 0);

  const mainImage =
    generalImages[0] || colorOptions[0]?.main_image || null;
  const sizeOptions = deriveSizeOptions(variants, product.size_mode || "none");

  return {
    ...product,
    size_mode: product.size_mode || "none",
    size_options: sizeOptions,
    color_options: colorOptions,
    variants,
    images: generalImages,
    main_image: mainImage,
    stock,
    has_variants: variants.length > 0,
  };
}

function buildRelatedProductImageSubquery() {
  return `
    COALESCE(
      (SELECT pi.image_url
       FROM product_images pi
       WHERE pi.product_id = p.id
       ORDER BY pi.is_main DESC, pi.id ASC
       LIMIT 1),
      (SELECT pci.image_url
       FROM product_color_images pci
       INNER JOIN product_colors pc ON pc.id = pci.product_color_id
       WHERE pc.product_id = p.id
       ORDER BY pci.is_main DESC, pci.sort_order ASC, pci.id ASC
       LIMIT 1)
    )
  `;
}

/**
 * Core Engine: Saves or Updates a Product and all its multi-dimensional relationships.
 * 
 * Execution Flow (Atomic Transaction):
 *  1. Process Multipart FormData (Files + JSON payload strings).
 *  2. Validate Color Hex Codes and ensure unique Client Keys.
 *  3. Calculate the Expected Variant Combinations array (Color × Size).
 *  4. Verify the incoming `variant_stock` array perfectly matches the expected combinations.
 *  5. Insert/Update `products` base table.
 *  6. Wipe and Insert new `product_images` (if it's a simple product).
 *  7. Sync `product_colors` and `product_color_images` to disk.
 *  8. Wipe and Re-insert `product_variants` exact stock rows based on combinations.
 *  9. Commit Transaction.
 * 
 * @param {Object} req - The Express Request object (contains Multer files and body payload)
 * @param {Object|null} existingProduct - If provided, the engine runs in UPDATE mode instead of CREATE.
 * @returns {Promise<{success: boolean, message: string, productId: number}>}
 */
async function saveProductRecord(req, existingProduct = null) {
  const connection = await db.getConnection();
  try {
    await ensureFinancialColumns(connection);

    await ensurePosSchema();

    let generatedBarcode = null;

    let {
      name,
      name_ar,
      category_id,
      price,
      original_price,
      old_price,
      description,
      description_ar,
      specs_en,
      specs_ar,
      stock,
      is_active,
      size_mode,
      size_options,
      colors,
      variant_stock,
    } = req.body || {};

    const normalizedSizeMode = normalizeSizeMode(size_mode);
    const normalizedSizeOptions = normalizeSizeOptions(
      normalizedSizeMode,
      size_options,
    );
    const normalizedColors = normalizeColors(colors);
    const normalizedVariantStock = normalizeVariantStock(variant_stock);
    const { generalImages, colorImages } = groupProductFiles(req.files || []);

    const hasColors = normalizedColors.length > 0;
    const hasVariants = hasColors || normalizedSizeOptions.length > 0;

    if (!name || !category_id || !price || !original_price || !description) {
      const error = new Error("All required product fields must be provided.");
      error.status = 400;
      throw error;
    }

    if (normalizedSizeMode !== "none" && normalizedSizeOptions.length === 0) {
      const error = new Error("Please choose at least one valid size option.");
      error.status = 400;
      throw error;
    }

    if (normalizedColors.some((color) => !validateHexColor(color.value))) {
      const error = new Error("Each color must use a valid HEX value.");
      error.status = 400;
      throw error;
    }

    price = parseFloat(price);
    original_price = parseFloat(original_price);
    old_price =
      old_price !== undefined && old_price !== "" && old_price !== null
        ? parseFloat(old_price)
        : null;
    is_active =
      is_active !== undefined
        ? `${is_active}` === "1" || `${is_active}` === "true"
        : existingProduct?.is_active ?? true;

    if (Number.isNaN(price) || price < 0) {
      const error = new Error("Selling price must be a valid number.");
      error.status = 400;
      throw error;
    }

    if (Number.isNaN(original_price) || original_price < 0) {
      const error = new Error("Original price must be a valid number.");
      error.status = 400;
      throw error;
    }

    if (old_price !== null && (Number.isNaN(old_price) || old_price < 0)) {
      const error = new Error("Discount must be zero or greater.");
      error.status = 400;
      throw error;
    }

    // net_profit = selling price − cost price (positive = business gain)
    const net_profit = Math.round((price - original_price) * 100) / 100;

    const expectedCombos = getExpectedVariantCombos(
      normalizedColors,
      normalizedSizeOptions,
    );

    const variantStockByCombo = new Map();
    for (const variant of normalizedVariantStock) {
      const comboKey = buildVariantComboKey(
        variant.color_key,
        variant.size_value,
      );

      if (Number.isNaN(variant.stock) || variant.stock < 0) {
        const error = new Error("Variant stock must be zero or greater.");
        error.status = 400;
        throw error;
      }

      if (variantStockByCombo.has(comboKey)) {
        const error = new Error("Duplicate variant stock rows were detected.");
        error.status = 400;
        throw error;
      }

      variantStockByCombo.set(comboKey, variant);
    }

    if (hasVariants) {
      for (const combo of expectedCombos) {
        const comboKey = buildVariantComboKey(
          combo.color_key,
          combo.size_value,
        );
        if (!variantStockByCombo.has(comboKey)) {
          const error = new Error(
            "Every color / size combination must have its own stock value.",
          );
          error.status = 400;
          throw error;
        }
      }
    }

    if (hasColors) {
      for (const color of normalizedColors) {
        const files = colorImages.get(color.client_key) || [];
        if (!existingProduct && files.length === 0) {
          const error = new Error(
            `Please upload at least one image for color "${color.name}".`,
          );
          error.status = 400;
          throw error;
        }
        if (files.length > 5) {
          const error = new Error(
            `Color "${color.name}" cannot have more than 5 images.`,
          );
          error.status = 400;
          throw error;
        }
      }
    }

    if (!hasColors && generalImages.length === 0 && !existingProduct) {
      const error = new Error("At least one main product image is required.");
      error.status = 400;
      throw error;
    }

    const totalVariantStock = hasVariants
      ? expectedCombos.reduce((sum, combo) => {
          const entry = variantStockByCombo.get(
            buildVariantComboKey(combo.color_key, combo.size_value),
          );
          return sum + Number(entry.stock || 0);
        }, 0)
      : Number.parseInt(stock, 10);

    if (!hasVariants && (Number.isNaN(totalVariantStock) || totalVariantStock < 0)) {
      const error = new Error("Stock must be zero or greater.");
      error.status = 400;
      throw error;
    }

    const slug = slugify(name, { lower: true, strict: true });

    await connection.beginTransaction();

    const [duplicateRows] = await connection.query(
      "SELECT id FROM products WHERE name = ? AND id != ? LIMIT 1",
      [name, existingProduct?.id || 0],
    );
    if (duplicateRows.length) {
      const error = new Error("Product already exists.");
      error.status = 400;
      throw error;
    }

    let productId = existingProduct?.id;

    if (existingProduct) {
      await connection.query(
        `
          UPDATE products
          SET name = ?, name_ar = ?, category_id = ?, price = ?, original_price = ?, old_price = ?,
              slug = ?, description = ?, description_ar = ?, specs_en = ?, specs_ar = ?,
              stock = ?, is_active = ?, size_mode = ?, net_profit = ?,
              base_selling_price = ?
          WHERE id = ?
        `,
        [
          name,
          name_ar || null,
          category_id,
          price,
          original_price,
          old_price,
          slug,
          description,
          description_ar || null,
          specs_en || null,
          specs_ar || null,
          totalVariantStock,
          is_active ? 1 : 0,
          normalizedSizeMode,
          net_profit,
          price, // base_selling_price is reset to the new admin-set price on every manual edit
          productId,
        ],
      );
    } else {
      const [result] = await connection.query(
        `
          INSERT INTO products (
            name, name_ar, category_id, price, original_price, net_profit, old_price, slug, description,
            description_ar, specs_en, specs_ar, stock, is_active, size_mode, base_selling_price
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          name,
          name_ar || null,
          category_id,
          price,
          original_price,
          net_profit,
          old_price,
          slug,
          description,
          description_ar || null,
          specs_en || null,
          specs_ar || null,
          totalVariantStock,
          is_active ? 1 : 0,
          normalizedSizeMode,
          price, // base_selling_price = selling price set by admin at creation
        ],
      );
      productId = result.insertId;
      generatedBarcode = await assignBarcodeToProduct(connection, productId);
    }

    if (hasColors) {
      await connection.query("DELETE FROM product_images WHERE product_id = ?", [
        productId,
      ]);
    } else if (generalImages.length > 0) {
      await connection.query("DELETE FROM product_images WHERE product_id = ?", [
        productId,
      ]);

      await Promise.all(
        generalImages.map((file, index) =>
          connection.query(
            "INSERT INTO product_images (product_id, image_url, is_main) VALUES (?, ?, ?)",
            [productId, file.path, index === 0 ? 1 : 0],
          ),
        ),
      );
    }

    const [existingColorsRows] = await connection.query(
      "SELECT id FROM product_colors WHERE product_id = ?",
      [productId],
    );
    const existingColorIds = new Set(existingColorsRows.map((row) => row.id));
    const keptColorIds = new Set();
    const colorIdByClientKey = new Map();

    if (hasColors) {
      for (const color of normalizedColors) {
        let productColorId = color.id;

        if (productColorId) {
          if (!existingColorIds.has(productColorId)) {
            const error = new Error("One or more colors are invalid.");
            error.status = 400;
            throw error;
          }

          await connection.query(
            `
              UPDATE product_colors
              SET name = ?, value = ?, sort_order = ?
              WHERE id = ? AND product_id = ?
            `,
            [
              color.name,
              color.value,
              color.sort_order,
              productColorId,
              productId,
            ],
          );
        } else {
          const [colorResult] = await connection.query(
            `
              INSERT INTO product_colors (product_id, name, value, sort_order)
              VALUES (?, ?, ?, ?)
            `,
            [productId, color.name, color.value, color.sort_order],
          );
          productColorId = colorResult.insertId;
        }

        keptColorIds.add(productColorId);
        colorIdByClientKey.set(color.client_key, productColorId);

        const uploadedFiles = colorImages.get(color.client_key) || [];
        if (uploadedFiles.length > 0) {
          await connection.query(
            "DELETE FROM product_color_images WHERE product_color_id = ?",
            [productColorId],
          );

          await Promise.all(
            uploadedFiles.map((file, index) =>
              connection.query(
                `
                  INSERT INTO product_color_images (
                    product_color_id, image_url, sort_order, is_main
                  ) VALUES (?, ?, ?, ?)
                `,
                [productColorId, file.path, index, index === 0 ? 1 : 0],
              ),
            ),
          );
        }
      }

      const idsToDelete = [...existingColorIds].filter(
        (id) => !keptColorIds.has(id),
      );
      if (idsToDelete.length) {
        await connection.query("DELETE FROM product_colors WHERE id IN (?)", [
          idsToDelete,
        ]);
      }
    } else {
      await connection.query("DELETE FROM product_colors WHERE product_id = ?", [
        productId,
      ]);
    }

    await connection.query("DELETE FROM product_variants WHERE product_id = ?", [
      productId,
    ]);

    if (hasVariants) {
      const variantRows = expectedCombos.map((combo) => {
        const entry = variantStockByCombo.get(
          buildVariantComboKey(combo.color_key, combo.size_value),
        );
        return [
          productId,
          combo.color_key ? colorIdByClientKey.get(combo.color_key) : null,
          combo.size_value,
          entry.stock,
        ];
      });

      await connection.query(
        `
          INSERT INTO product_variants (product_id, product_color_id, size_value, stock)
          VALUES ?
        `,
        [variantRows],
      );
    }

    if (!hasColors) {
      const [[generalImageCount]] = await connection.query(
        "SELECT COUNT(*) AS total FROM product_images WHERE product_id = ?",
        [productId],
      );
      if (generalImageCount.total === 0) {
        const error = new Error(
          "Please keep at least one product image when colors are disabled.",
        );
        error.status = 400;
        throw error;
      }
    } else {
      const colorIdsToValidate = [...keptColorIds];
      if (colorIdsToValidate.length) {
        const [colorImageCounts] = await connection.query(
          `
            SELECT product_color_id, COUNT(*) AS total
            FROM product_color_images
            WHERE product_color_id IN (?)
            GROUP BY product_color_id
          `,
          [colorIdsToValidate],
        );
        const countsByColorId = new Map(
          colorImageCounts.map((row) => [row.product_color_id, Number(row.total)]),
        );

        for (const color of normalizedColors) {
          const colorId = colorIdByClientKey.get(color.client_key);
          if (!countsByColorId.get(colorId)) {
            const error = new Error(
              `Color "${color.name}" must keep at least one image.`,
            );
            error.status = 400;
            throw error;
          }
        }
      }
    }

    await connection.commit();

    return {
      success: true,
      message: existingProduct
        ? "Product updated successfully"
        : "Product created successfully",
      productId,
      barcode: generatedBarcode,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

function getOptionalUser(req) {
  let token = req.cookies?.token;

  if (!token) {
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) {
      token = header.split(" ")[1];
    }
  }

  if (!token) return null;

  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return null;
  }
}

function canViewAdminFinancialFields(req) {
  const user = req.user || getOptionalUser(req);
  return user?.role === "admin" || user?.role === "owner";
}

function sanitizeProductForViewer(product, req) {
  if (canViewAdminFinancialFields(req)) {
    return product;
  }

  const { net_profit, barcode, original_price, ...publicProduct } = product;
  return publicProduct;
}

/**
 * POST /api/products
 * 
 * Admin endpoint to create a new product. Wraps the `saveProductRecord` engine.
 * Access: Protected (Admin or Owner)
 */
const createProduct = async (req, res, next) => {
  try {
    const result = await saveProductRecord(req);
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/products
 * 
 * Deeply optimized endpoint to fetch a paginated table of products.
 * 
 * Features:
 *  - Multi-term Fuzzy Search: Breaks down the search query into words, applies translation equivalents (`expandQuery`),
 *    and searches across multiple fields (name, name_ar, description).
 *  - Category and Price Range Filtering.
 *  - Hydrates each product with its supplementary variants, colors, and images automatically.
 *  - Security (`sanitizeProductForViewer`): Strips sensitive data like `net_profit` from public API consumers.
 * 
 * @route   GET /api/products
 * @access  Public (Guest accessible, but admins see more fields)
 */
const getAllProducts = async (req, res, next) => {
  try {
    await ensureFinancialColumns();

    const page = Number.parseInt(req.query.page, 10) || 1;
    const limit = Number.parseInt(req.query.limit, 10) || 20;
    const offset = (page - 1) * limit;
    const name = req.query.name || "";
    const category_id = req.query.category_id || "";
    const min_price = req.query.min_price || "";
    const max_price = req.query.max_price || "";

    const whereConditions = [];
    const queryParams = [];

    if (name) {
      const words = name
        .trim()
        .split(/\s+/)
        .filter((word) => word.length > 1);

      const wordGroups = [];
      for (const word of words) {
        const expandedTerms = expandQuery(word);
        const termClauses = [];
        for (const term of expandedTerms) {
          const likeTerm = `%${term}%`;
          termClauses.push(
            "(products.name LIKE ? OR products.name_ar LIKE ? OR products.description LIKE ? OR products.description_ar LIKE ?)",
          );
          queryParams.push(likeTerm, likeTerm, likeTerm, likeTerm);
        }
        wordGroups.push(`(${termClauses.join(" OR ")})`);
      }

      if (wordGroups.length) {
        whereConditions.push(`(${wordGroups.join(" AND ")})`);
      }
    }

    if (category_id) {
      whereConditions.push("products.category_id = ?");
      queryParams.push(category_id);
    }

    if (min_price) {
      whereConditions.push("products.price >= ?");
      queryParams.push(Number.parseFloat(min_price));
    }

    if (max_price) {
      whereConditions.push("products.price <= ?");
      queryParams.push(Number.parseFloat(max_price));
    }

    const whereClause = whereConditions.length
      ? `WHERE ${whereConditions.join(" AND ")}`
      : "";

    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total FROM products ${whereClause}`,
      queryParams,
    );

    const [rows] = await db.query(
      `
        SELECT products.*, categories.name AS category_name, categories.name_ar AS category_name_ar
        FROM products
        LEFT JOIN categories ON categories.id = products.category_id
        ${whereClause}
        ORDER BY products.id DESC
        LIMIT ? OFFSET ?
      `,
      [...queryParams, limit, offset],
    );

    const supplementaryData = await getProductsSupplementaryData(
      db,
      rows.map((product) => product.id),
    );

    const products = rows.map((product) =>
      sanitizeProductForViewer(
        decorateProduct(product, supplementaryData),
        req,
      ),
    );

    res.status(200).json({
      success: true,
      message: "Products fetched successfully",
      data: products,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit) || 1,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/products/:id
 * 
 * Fetches a single product deeply populated with all its options, sizes, and colors.
 * Used on the public Product Detail Page (PDP).
 * Also asynchronously calculates the live Review Average Rating and fetches 5 Related Products.
 * 
 * @route   GET /api/products/:id
 * @access  Public
 */
const getProductById = async (req, res, next) => {
  try {
    await ensureFinancialColumns();
    await ensurePosSchema();

    const id = Number.parseInt(req.params.id, 10);
    if (!id) {
      return res.status(400).json({ message: "Product not found" });
    }

    let [rows] = await db.query(
      `
        SELECT products.*, categories.name AS category_name, categories.name_ar AS category_name_ar
        FROM products
        LEFT JOIN categories ON categories.id = products.category_id
        WHERE products.id = ?
      `,
      [id],
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Product not found" });
    }

    if (canViewAdminFinancialFields(req) && !rows[0].barcode) {
      const barcode = await assignBarcodeToProduct(db, id);
      rows[0].barcode = barcode;
    }

    const supplementaryData = await getProductsSupplementaryData(db, [id]);
    const product = sanitizeProductForViewer(
      decorateProduct(rows[0], supplementaryData),
      req,
    );

    const [[ratingData]] = await db.query(
      `
        SELECT COALESCE(AVG(rating), 0) AS avg_rating, COUNT(*) AS review_count
        FROM reviews
        WHERE product_id = ? AND is_approved = TRUE
      `,
      [id],
    );
    product.avg_rating = +Number(ratingData.avg_rating).toFixed(1);
    product.review_count = ratingData.review_count;

    const [related] = await db.query(
      `
        SELECT
          p.id,
          p.name,
          p.name_ar,
          p.price,
          COALESCE((SELECT SUM(pv.stock) FROM product_variants pv WHERE pv.product_id = p.id), p.stock) AS stock,
          ${buildRelatedProductImageSubquery()} AS main_image
        FROM products p
        WHERE p.category_id = ? AND p.id != ? AND p.is_active = 1
        ORDER BY RAND()
        LIMIT 5
      `,
      [product.category_id, id],
    );
    product.related_products = related;

    res.status(200).json({
      success: true,
      message: "Product fetched successfully",
      data: product,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * PUT /api/products/:id
 * 
 * Admin endpoint to edit an existing product. 
 * Invokes the `saveProductRecord` engine in "UPDATE" mode.
 * 
 * @route   PUT /api/products/:id
 * @access  Protected (Admin or Owner)
 */
const updateProduct = async (req, res, next) => {
  try {
    await ensureFinancialColumns();

    const id = Number.parseInt(req.params.id, 10);
    const [[existingProduct]] = await db.query(
      "SELECT * FROM products WHERE id = ?",
      [id],
    );

    if (!existingProduct) {
      return res.status(404).json({ message: "Product not found" });
    }

    const result = await saveProductRecord(req, existingProduct);
    res.status(200).json({ success: true, message: result.message });
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /api/products/:id
 * 
 * Fully purges a product and unlinks all memory footprints out of the database.
 * Cascades downwards into `product_images`, `product_colors`, and `product_variants`.
 * Wrapped entirely in an atomic Transaction to prevent dangling orphans.
 * 
 * @route   DELETE /api/products/:id
 * @access  Protected (Admin or Owner)
 */
const deleteProduct = async (req, res, next) => {
  const connection = await db.getConnection();
  try {
    const id = Number.parseInt(req.params.id, 10);

    const [rows] = await connection.query(
      "SELECT * FROM products WHERE id = ?",
      [id],
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Product not found" });
    }

    await connection.beginTransaction();
    await connection.query("DELETE FROM product_images WHERE product_id = ?", [
      id,
    ]);
    await connection.query("DELETE FROM product_colors WHERE product_id = ?", [
      id,
    ]);
    await connection.query("DELETE FROM product_variants WHERE product_id = ?", [
      id,
    ]);
    await connection.query("DELETE FROM products WHERE id = ?", [id]);
    await connection.commit();

    res.status(200).json({
      success: true,
      message: "Product and its related data deleted successfully",
    });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
};

export {
  createProduct,
  getAllProducts,
  getProductById,
  updateProduct,
  deleteProduct,
};
