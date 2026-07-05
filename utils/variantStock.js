/**
 * @file variantStock.js
 * @description Utility functions for managing product variant stock levels.
 *
 * This module handles stock deduction and restoration atomically within DB transactions.
 * It supports two types of products:
 *  1. Simple products (no variants): Stock tracked directly on the `products` table
 *  2. Variant products (with colors/sizes): Stock tracked per variant in `product_variants`
 *     with the aggregate stock also synced back to `products.stock`
 *
 * Usage:
 *  - deductOrderItemStock  — Called when an order is placed (order creation)
 *  - restoreOrderItemStock — Called when an order is cancelled/rejected/returned
 *  - syncProductsStock     — Internal helper to keep products.stock in sync with variants
 *
 * IMPORTANT: All functions accept a `connection` argument (NOT the pool directly)
 * because they must run within the caller's active transaction to maintain atomicity.
 * Never call these functions with `db` (the pool) — always pass `connection`.
 */

/**
 * Synchronizes the aggregate stock on the `products` table from the sum of
 * all variant stocks in `product_variants`.
 *
 * Called automatically after deduct/restore operations on variant products.
 * This keeps `products.stock` consistent with the actual per-variant totals.
 *
 * Uses LEFT JOIN + COALESCE so that if a product has no variants,
 * its current `products.stock` value is preserved unchanged.
 *
 * @param {object}   connection - Active MySQL connection (within a transaction)
 * @param {number[]} productIds - Array of product IDs to sync
 */
export async function syncProductsStock(connection, productIds = []) {
  // De-duplicate and filter invalid IDs
  const uniqueIds = [...new Set((productIds || []).map(Number).filter(Boolean))];
  if (!uniqueIds.length) return;

  await connection.query(
    `
      UPDATE products p
      LEFT JOIN (
        SELECT product_id, SUM(stock) AS total_stock
        FROM product_variants
        WHERE product_id IN (?)
        GROUP BY product_id
      ) pv ON pv.product_id = p.id
      SET p.stock = COALESCE(pv.total_stock, p.stock)
      WHERE p.id IN (?)
    `,
    [uniqueIds, uniqueIds],
  );
}

/**
 * Deducts stock from the database when an order is placed.
 *
 * Logic:
 *  - For items with a variant_id: Deducts from `product_variants.stock`
 *    and then calls syncProductsStock to update `products.stock`
 *  - For items without a variant_id (simple products): Deducts directly
 *    from `products.stock`
 *
 * Uses GREATEST(stock - qty, 0) to prevent negative stock values
 * (stock floor is 0 even if somehow oversold).
 *
 * Called inside createOrder with an active transaction connection.
 *
 * @param {object} connection - Active MySQL connection (within a transaction)
 * @param {number} orderId    - The newly created order's ID
 */
export async function deductOrderItemStock(connection, orderId) {
  // Fetch all items for this order
  const [items] = await connection.query(
    "SELECT product_id, variant_id, quantity FROM order_items WHERE order_id = ?",
    [orderId],
  );

  // Track which product IDs need aggregate stock sync (variant products only)
  const variantProductIds = new Set();

  for (const item of items) {
    if (item.variant_id) {
      // Variant product: deduct from the specific variant's stock
      // GREATEST prevents negative stock even in edge cases
      await connection.query(
        "UPDATE product_variants SET stock = GREATEST(stock - ?, 0) WHERE id = ?",
        [item.quantity, item.variant_id],
      );
      variantProductIds.add(item.product_id);
    } else {
      // Simple product: deduct directly from the product's stock
      await connection.query(
        "UPDATE products SET stock = GREATEST(stock - ?, 0) WHERE id = ?",
        [item.quantity, item.product_id],
      );
    }
  }

  // Sync the aggregate stock for all affected variant products
  await syncProductsStock(connection, [...variantProductIds]);
}

/**
 * Restores (adds back) stock when an order is cancelled, rejected, or returned.
 *
 * This is the reverse of deductOrderItemStock.
 * Note: Unlike deduction, restoration does NOT use GREATEST()
 * because we always want to add back the exact quantity that was removed.
 *
 * Called inside updateOrderStatus / verifyPayment with an active transaction.
 *
 * @param {object} connection - Active MySQL connection (within a transaction)
 * @param {number} orderId    - The order whose items should have stock restored
 */
export async function restoreOrderItemStock(connection, orderId) {
  const [items] = await connection.query(
    "SELECT product_id, variant_id, quantity FROM order_items WHERE order_id = ?",
    [orderId],
  );

  const variantProductIds = new Set();

  for (const item of items) {
    if (item.variant_id) {
      // Variant product: restore stock to the specific variant
      await connection.query(
        "UPDATE product_variants SET stock = stock + ? WHERE id = ?",
        [item.quantity, item.variant_id],
      );
      variantProductIds.add(item.product_id);
    } else {
      // Simple product: restore directly to the product's stock
      await connection.query(
        "UPDATE products SET stock = stock + ? WHERE id = ?",
        [item.quantity, item.product_id],
      );
    }
  }

  // Re-sync aggregate product stock for affected variant products
  await syncProductsStock(connection, [...variantProductIds]);
}

/**
 * Deducts stock from a list of items (used by POS).
 */
export async function deductStockItems(connection, items = []) {
  const variantProductIds = new Set();

  for (const item of items) {
    const qty = Number(item.quantity) || 0;
    if (qty <= 0) continue;

    if (item.variant_id) {
      await connection.query(
        "UPDATE product_variants SET stock = GREATEST(stock - ?, 0) WHERE id = ?",
        [qty, item.variant_id],
      );
      variantProductIds.add(item.product_id);
    } else {
      await connection.query(
        "UPDATE products SET stock = GREATEST(stock - ?, 0) WHERE id = ?",
        [qty, item.product_id],
      );
    }
  }

  await syncProductsStock(connection, [...variantProductIds]);
}

/**
 * Restores stock from a list of items (used by POS returns).
 */
export async function restoreStockItems(connection, items = []) {
  const variantProductIds = new Set();

  for (const item of items) {
    const qty = Number(item.quantity) || 0;
    if (qty <= 0) continue;

    if (item.variant_id) {
      await connection.query(
        "UPDATE product_variants SET stock = stock + ? WHERE id = ?",
        [qty, item.variant_id],
      );
      variantProductIds.add(item.product_id);
    } else {
      await connection.query(
        "UPDATE products SET stock = stock + ? WHERE id = ?",
        [qty, item.product_id],
      );
    }
  }

  await syncProductsStock(connection, [...variantProductIds]);
}
