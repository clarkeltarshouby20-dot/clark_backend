/**
 * @file category.controllers.js
 * @description Category management controller for the product catalog.
 *
 * Categories are the top-level taxonomy for organizing products.
 * Each product belongs to exactly one category.
 *
 * Endpoints:
 *  - createCategory              — POST   /categories        — Create a new category
 *  - getAllCategories             — GET    /categories        — List all categories (plain)
 *  - getCategoriesWithProducts   — GET    /categories/with-products — All categories + their products
 *  - getCategoryById             — GET    /categories/:id    — Fetch a single category
 *  - getCategoryByIdWithProducts — GET    /categories/:id/products — Category + its products
 *  - updateCategory              — PUT    /categories/:id    — Update category fields/image
 *  - deleteCategory              — DELETE /categories/:id    — Cascade delete category + products
 *
 * Notes:
 *  - Slugs are auto-generated from the English name using the `slugify` library
 *  - Both English (name) and Arabic (name_ar) names are required for bilingual support
 *  - deleteCategory uses a transaction to cascade-delete product images → products → category
 */

import db from "../config/db.js";
import slugify from "slugify";
import { ensureCategorySchema } from "../utils/categorySchema.js";
import { ensureFinancialColumns } from "../utils/financialSchema.js";

// ── createCategory ─────────────────────────────────────────────────────────────
/**
 * POST /api/categories
 *
 * Creates a new product category. Both English and Arabic names are required.
 * Slug is auto-generated from the English name (URL-safe, lowercase, hyphened).
 *
 * Body: { name, name_ar, parent_id?, is_active?, sort_order? }
 * File: image (via Multer — optional)
 *
 * @route  POST /api/categories
 * @access Protected — Admin or Owner only
 */
const createCategory = async (req, res, next) => {
  try {
    let { name, slug, parent_id, is_active, sort_order, name_ar } =
      req.body || {};

    // Apply defaults for optional fields
    parent_id = parent_id || null;
    is_active = is_active !== undefined ? is_active : true;
    sort_order = sort_order !== undefined ? sort_order : 0;

    // Auto-generate the slug from the English name (e.g., "Men's Shoes" → "mens-shoes")
    slug = slugify(name, { lower: true, strict: true });

    // Both English name and Arabic name are required for the bilingual UI
    if (!name || !slug || !name_ar) {
      return res.status(400).json({ message: "Name and slug are required" });
    }

    // Get the Cloudinary URL from uploaded file (if any)
    const image_url = req.file ? req.file.path : "";

    // Check for duplicate slug to prevent two categories with the same URL identifier
    const [rows] = await db.query("SELECT * FROM categories WHERE slug = ?", [
      slug,
    ]);
    if (rows.length > 0) {
      return res.status(400).json({ message: "Category already exists" });
    }

    // Insert the new category
    const [result] = await db.query(
      "INSERT INTO categories (name, slug, parent_id, is_active, sort_order, image_url,name_ar) VALUES (?, ?, ?, ?, ?, ?,?)",
      [name, slug, parent_id, is_active, sort_order, image_url, name_ar],
    );
    if (result.affectedRows === 0) {
      return res.status(400).json({ message: "Category not created" });
    }

    res.status(201).json({ message: "Category created successfully" });
  } catch (error) {
    next(error);
  }
};

// ── getCategoriesWithProducts ─────────────────────────────────────────────────
/**
 * GET /api/categories/with-products
 *
 * Fetches all categories and aggregates their associated active products
 * into a JSON array using MySQL's JSON_ARRAYAGG + JSON_OBJECT.
 * Used on the homepage to display category carousels.
 *
 * Each product in the array includes: id, name, name_ar, price, slug, image (first image only)
 * Categories with no products get an empty array [].
 *
 * @route  GET /api/categories/with-products
 * @access Public
 */
const getCategoriesWithProducts = async (req, res, next) => {
  try {
    // MySQL JSON functions aggregate products inline without N+1 queries
    const [rows] = await db.query(`
      SELECT 
        categories.*,
        IF(COUNT(products.id) > 0, 
          JSON_ARRAYAGG(
            JSON_OBJECT(
              'id', products.id,
              'name', products.name,
              'name_ar', products.name_ar,
              'price', products.price,
              'slug', products.slug,
              'image', (
                SELECT image_url 
                FROM product_images 
                WHERE product_images.product_id = products.id 
                LIMIT 1
              )
            )
          ), 
          JSON_ARRAY()
        ) AS products
      FROM categories
      LEFT JOIN products ON categories.id = products.category_id
      GROUP BY categories.id
    `);

    // MySQL returns JSON columns as strings — parse them into real JS arrays
    const categories = rows.map((category) => ({
      ...category,
      products:
        typeof category.products === "string"
          ? JSON.parse(category.products)
          : category.products,
    }));

    res.status(200).json({
      status: true,
      message: "Categories and their linked products fetched successfully",
      categories,
    });
  } catch (error) {
    next(error);
  }
};

// ── getMostVisitedCategories ───────────────────────────────────────────────────
/**
 * GET /api/categories/most-visited?limit=2
 *
 * Returns active categories ordered by visit_count (desc).
 * Falls back to sort_order when visit counts are tied or zero.
 */
const getMostVisitedCategories = async (req, res, next) => {
  try {
    await ensureCategorySchema();
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 2, 1), 6);

    const [rows] = await db.query(
      `
      SELECT *
      FROM categories
      WHERE is_active = 1
      ORDER BY visit_count DESC, sort_order ASC, id ASC
      LIMIT ?
    `,
      [limit],
    );

    res.status(200).json({
      success: true,
      message: "Most visited categories fetched successfully",
      data: rows,
    });
  } catch (error) {
    next(error);
  }
};

// ── recordCategoryVisit ────────────────────────────────────────────────────────
/**
 * POST /api/categories/:id/visit
 *
 * Increments the visit counter for a category (homepage promos, filters, etc.).
 */
const recordCategoryVisit = async (req, res, next) => {
  try {
    await ensureCategorySchema();
    const { id } = req.params;

    const [result] = await db.query(
      "UPDATE categories SET visit_count = visit_count + 1 WHERE id = ? AND is_active = 1",
      [id],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: "Category not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Category visit recorded",
    });
  } catch (error) {
    next(error);
  }
};

// ── getAllCategories ───────────────────────────────────────────────────────────
/**
 * GET /api/categories
 *
 * Returns all categories as a flat array without product data.
 * Used for admin dropdowns, filter sidebars, and site navigation.
 *
 * @route  GET /api/categories
 * @access Public
 */
const getAllCategories = async (req, res, next) => {
  try {
    await ensureCategorySchema();
    const [rows] = await db.query("SELECT * FROM categories");
    if (rows.length === 0) {
      return res.status(400).json({ message: "Categories not found" });
    }
    res
      .status(200)
      .json({
        success: true,
        message: "Categories fetched successfully",
        data: rows,
      });
  } catch (error) {
    next(error);
  }
};

// ── getCategoryById ────────────────────────────────────────────────────────────
/**
 * GET /api/categories/:id
 *
 * Fetches a single category by its database ID.
 * Returns only category fields (no products).
 *
 * @route  GET /api/categories/:id
 * @access Public
 */
const getCategoryById = async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!id) {
      return res.status(400).json({ message: "Category not found" });
    }
    const [rows] = await db.query("SELECT * FROM categories WHERE id = ?", [
      id,
    ]);
    if (rows.length === 0) {
      return res.status(400).json({ message: "Category not found" });
    }
    res
      .status(200)
      .json({ message: "Category fetched successfully", category: rows[0] });
  } catch (error) {
    next(error);
  }
};

// ── getCategoryByIdWithProducts ────────────────────────────────────────────────
/**
 * GET /api/categories/:id/products
 *
 * Fetches a specific category AND its associated products aggregated via JSON_ARRAYAGG.
 * Used when a user clicks on a category from the navigation menu.
 *
 * The MySQL query returns products_list as a JSON string from DB.
 * We parse it and expose it as the clean `products` array in the response.
 *
 * @route  GET /api/categories/:id/products
 * @access Public
 */
const getCategoryByIdWithProducts = async (req, res, next) => {
  try {
    const { id } = req.params;

    const [rows] = await db.query(
      `
      SELECT 
        categories.*,
        IF(COUNT(products.id) > 0, 
          JSON_ARRAYAGG(
            JSON_OBJECT(
              'id', products.id,
              'name', products.name,
              'name_ar', products.name_ar,
              'price', products.price,
              'slug', products.slug,
              'image', (
                SELECT image_url 
                FROM product_images 
                WHERE product_images.product_id = products.id 
                LIMIT 1
              )
            )
          ), 
          JSON_ARRAY()
        ) AS products_list
      FROM categories
      LEFT JOIN products ON categories.id = products.category_id
      WHERE categories.id = ?
      GROUP BY categories.id
    `,
      [id],
    );

    if (rows.length === 0) {
      return res.status(404).json({
        status: false,
        message: "Category not found",
      });
    }

    // Reshape the row: rename products_list → products, and parse the JSON string
    const category = {
      ...rows[0],
      products:
        typeof rows[0].products_list === "string"
          ? JSON.parse(rows[0].products_list)
          : rows[0].products_list,
    };

    // Remove the raw database field (already exposed as 'products')
    delete category.products_list;

    res.status(200).json({
      status: true,
      message: "Category with its linked products fetched successfully",
      category,
    });
  } catch (error) {
    next(error);
  }
};

// ── updateCategory ─────────────────────────────────────────────────────────────
/**
 * PUT /api/categories/:id
 *
 * Updates a category's fields. Supports partial updates — any omitted field
 * falls back to the existing value from the database.
 *
 * Body: { name?, name_ar?, parent_id?, is_active?, sort_order? }
 * File: image (via Multer — optional, replaces existing image URL)
 *
 * @route  PUT /api/categories/:id
 * @access Protected — Admin or Owner only
 */
const updateCategory = async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!id) {
      return res.status(400).json({ message: "Category not found" });
    }

    // Fetch current category to use as defaults for any unspecified fields
    const [rows] = await db.query("SELECT * FROM categories WHERE id = ?", [
      id,
    ]);
    if (rows.length === 0) {
      return res.status(400).json({ message: "Category not found" });
    }

    let { name, slug, parent_id, is_active, sort_order, name_ar } =
      req.body || {};

    // Fall back to existing values for any unspecified fields
    name = name || rows[0].name;
    slug = name ? slugify(name, { lower: true, strict: true }) : rows[0].slug; // Regenerate slug from new name
    parent_id = parent_id || rows[0].parent_id;
    is_active = is_active !== undefined ? is_active : rows[0].is_active;
    sort_order = sort_order || rows[0].sort_order;
    name_ar = name_ar || rows[0].name_ar;

    // Use new uploaded image, or keep existing Cloudinary URL
    const image_url = req.file ? req.file.path : rows[0].image_url;

    const [result] = await db.query(
      "UPDATE categories SET name = ?, slug = ?, parent_id = ?, is_active = ?, sort_order = ?, image_url = ?,name_ar = ? WHERE id = ?",
      [name, slug, parent_id, is_active, sort_order, image_url, name_ar, id],
    );
    if (result.affectedRows === 0) {
      return res.status(400).json({ message: "Category not updated" });
    }

    res.status(200).json({ message: "Category updated successfully" });
  } catch (error) {
    next(error);
  }
};

// ── deleteCategory ─────────────────────────────────────────────────────────────
/**
 * DELETE /api/categories/:id
 *
 * Permanently deletes a category and all its associated data using a DB transaction.
 * Cascade order (to satisfy foreign key constraints):
 *  1. Delete product_images for all products in this category
 *  2. Delete all products in this category
 *  3. Delete the category itself
 *
 * IMPORTANT: This is a destructive operation. All products in the category are lost.
 * A dedicated transaction + connection is used to ensure atomicity.
 *
 * @route  DELETE /api/categories/:id
 * @access Protected — Admin or Owner only
 */
const deleteCategory = async (req, res, next) => {
  // Get a dedicated connection from the pool for this transaction
  const connection = await db.getConnection();

  try {
    const { id } = req.params;

    // Check the category exists before starting the transaction
    const [categoryRows] = await connection.query(
      "SELECT * FROM categories WHERE id = ?",
      [id],
    );
    if (categoryRows.length === 0) {
      await connection.release();
      return res.status(404).json({ message: "Category not found" });
    }

    // Start atomic transaction — all steps succeed or all are rolled back
    await connection.beginTransaction();

    // Step 1: Delete product images for all products in this category
    // (must happen BEFORE deleting products due to foreign key constraint)
    await connection.query(
      `DELETE FROM product_images 
       WHERE product_id IN (SELECT id FROM products WHERE category_id = ?)`,
      [id],
    );

    // Step 2: Delete all products belonging to this category
    await connection.query("DELETE FROM products WHERE category_id = ?", [id]);

    // Step 3: Delete the category record itself
    const [result] = await connection.query(
      "DELETE FROM categories WHERE id = ?",
      [id],
    );

    if (result.affectedRows === 0) {
      throw new Error("Failed to delete category from database");
    }

    // Commit the transaction — all steps succeeded
    await connection.commit();

    res.status(200).json({
      status: true,
      message: "Category and all its linked products/images deleted successfully",
    });
  } catch (error) {
    // Roll back all changes if any step failed
    await connection.rollback();
    next(error);
  } finally {
    // Always release the connection back to the pool (even on error)
    connection.release();
  }
};

// ── applyCategoryDiscount ──────────────────────────────────────────────────────
function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

/**
 * Computes the new price after applying a discount to the original selling price.
 * @param {number} listPrice     - Original (pre-discount) selling price
 * @param {string} discountType  - 'percent' | 'fixed'
 * @param {number} discountValue - Discount amount
 * @returns {number} New selling price, always >= 0
 */
function computeDiscountedPrice(listPrice, discountType, discountValue) {
  const list = roundMoney(listPrice);
  if (discountType === "percent") {
    const pct = Math.min(Math.max(Number(discountValue), 0), 100);
    return roundMoney(Math.max(list * (1 - pct / 100), 0));
  }
  const fixed = roundMoney(Number(discountValue));
  return roundMoney(Math.max(list - fixed, 0));
}

/**
 * POST /api/categories/:id/apply-discount
 *
 * Applies a percentage or fixed discount to every product in the category,
 * or clears (removes) an existing discount when discount_type = "none".
 *
 * ── Key fix: anti-compounding ─────────────────────────────────────────────
 * Before this fix, changing a 10% discount to 20% would apply the 20% on top
 * of the already-discounted price (e.g. 100 → 90 → 72), giving a ~28% effective
 * discount instead of 20%.
 *
 * Now, for every product we first reconstruct the *original selling price* by
 * adding back the stored discount amount (old_price), then apply the new
 * discount on that baseline. This ensures each call is idempotent and
 * independent of previous discount state.
 *
 * ── Fields used ──────────────────────────────────────────────────────────
 *  price       → current selling price (may already be discounted)
 *  old_price   → accumulated discount amount (selling - discounted selling)
 *  net_profit  → selling price - cost price  (positive = gain)
 *  original_price (fetched separately) → cost price set at product creation
 */
const applyCategoryDiscount = async (req, res, next) => {
  try {
    await ensureCategorySchema();
    await ensureFinancialColumns();

    const { id } = req.params;
    const { discount_type, discount_value } = req.body || {};

    // ── Validate discount_type ─────────────────────────────────────────────
    const discountType =
      discount_type === "fixed"   ? "fixed"  :
      discount_type === "percent" ? "percent":
      discount_type === "none"    ? "none"   : null;

    if (!discountType) {
      return res.status(400).json({
        success: false,
        message: "discount_type must be 'percent', 'fixed', or 'none'.",
      });
    }

    // ── Validate discount value for active discounts ───────────────────────
    let discountValue = 0;
    if (discountType !== "none") {
      discountValue = Number.parseFloat(discount_value);
      if (Number.isNaN(discountValue) || discountValue <= 0) {
        return res.status(400).json({
          success: false,
          message: "Discount value must be a positive number.",
        });
      }
      if (discountType === "percent" && discountValue > 100) {
        return res.status(400).json({
          success: false,
          message: "Percentage cannot exceed 100.",
        });
      }
    }

    // ── Fetch category ─────────────────────────────────────────────────────
    const [categoryRows] = await db.query(
      "SELECT id, name FROM categories WHERE id = ?",
      [id],
    );
    if (!categoryRows.length) {
      return res.status(404).json({ success: false, message: "Category not found." });
    }

    // ── Fetch products ─────────────────────────────────────────────────────
    // base_selling_price = immutable original selling price (admin-set, never changed by discounts)
    // original_price     = cost price (what the business paid)
    const [products] = await db.query(
      "SELECT id, price, old_price, net_profit, original_price, base_selling_price FROM products WHERE category_id = ?",
      [id],
    );
    if (!products.length) {
      return res.status(400).json({
        success: false,
        message: "This category has no products.",
      });
    }

    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      let updated = 0;

      for (const product of products) {
        // ── 1. Base selling price (immutable reference) ────────────────────
        // base_selling_price is set ONCE when the admin creates/edits a product
        // and is NEVER touched by the discount engine. This is the stable baseline
        // that prevents discounts from compounding on each other.
        //
        // Fallback (for products created before this column existed):
        // reconstruct from price + old_price, which equals the pre-discount selling price.
        const baseSellingPrice = roundMoney(
          Number(product.base_selling_price) > 0
            ? Number(product.base_selling_price)
            : Number(product.price || 0) + Number(product.old_price || 0),
        );

        // ── 2. Cost price (what the business paid for the item) ────────────
        const costPrice = roundMoney(Number(product.original_price || 0));

        let newPrice;
        let newOldPrice; // discount amount to persist in old_price

        if (discountType === "none") {
          // Remove discount: restore product to its base selling price
          newPrice    = baseSellingPrice;
          newOldPrice = null;
        } else {
          // Always discount from the BASE selling price — never from the current (discounted) price
          newPrice          = computeDiscountedPrice(baseSellingPrice, discountType, discountValue);
          const discountAmt = roundMoney(baseSellingPrice - newPrice);
          newOldPrice       = discountAmt > 0 ? discountAmt : null;
        }

        // ── 3. Recalculate net profit ──────────────────────────────────────
        // net_profit = new selling price − cost price  (positive = business gain)
        const newNetProfit = roundMoney(newPrice - costPrice);

        await connection.query(
          "UPDATE products SET price = ?, old_price = ?, net_profit = ? WHERE id = ?",
          [newPrice, newOldPrice, newNetProfit, product.id],
        );
        updated += 1;
      }

      // Persist discount metadata on the category row
      await connection.query(
        "UPDATE categories SET discount_type = ?, discount_value = ? WHERE id = ?",
        [discountType, discountType !== "none" ? discountValue : 0, id],
      );

      await connection.commit();

      res.status(200).json({
        success: true,
        message:
          discountType === "none"
            ? `Discount removed from ${updated} product(s).`
            : `Discount applied to ${updated} product(s).`,
        data: {
          updated_count:  updated,
          category_id:    Number(id),
          category_name:  categoryRows[0].name,
          discount_type:  discountType,
          discount_value: discountType !== "none" ? discountValue : 0,
        },
      });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  } catch (error) {
    next(error);
  }
};

// ── Exports ────────────────────────────────────────────────────────────────────
export {
  createCategory,
  getAllCategories,
  getCategoriesWithProducts,
  getMostVisitedCategories,
  recordCategoryVisit,
  getCategoryById,
  getCategoryByIdWithProducts,
  updateCategory,
  deleteCategory,
  applyCategoryDiscount,
};
