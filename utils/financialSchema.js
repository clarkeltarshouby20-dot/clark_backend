/**
 * @file financialSchema.js
 * @description On-demand schema migration utility for financial columns.
 *
 * This module ensures that two financial columns exist in the database
 * before any code that depends on them runs. It acts as a lazy schema migration:
 *
 *  - `products.net_profit` (DECIMAL 10,2, DEFAULT 0.00)
 *     → Tracks the profit margin per product (price minus cost)
 *
 *  - `order_items.unit_net_profit` (DECIMAL 10,2, DEFAULT 0.00)
 *     → Snapshot of the product's net_profit at the time of the order
 *       (preserved even if the product's net_profit is later changed)
 *
 * Why runtime migration?
 *  These columns may not exist on older database instances that were created
 *  before this feature was added. Rather than requiring manual ALTER TABLE,
 *  the code checks and adds them automatically on first use.
 *
 * Singleton pattern:
 *  `ensureFinancialColumnsPromise` caches the migration promise so the ALTER TABLE
 *  queries only run once per server lifetime, even if called from many request handlers.
 *
 * Usage:
 *  Call `await ensureFinancialColumns()` at the top of any controller that
 *  reads or writes net_profit or unit_net_profit fields.
 */

import db from "../config/db.js";

/**
 * Module-level singleton promise.
 * Set on the first call, reused on all subsequent calls.
 * Reset to null if the migration fails (allows retry on next request).
 *
 * @type {Promise<void>|null}
 */
let ensureFinancialColumnsPromise = null;

/**
 * Checks whether a specific column exists in a given table.
 * Uses INFORMATION_SCHEMA which is supported by MySQL and TiDB.
 *
 * @param {object} connection - Active MySQL connection
 * @param {string} tableName  - Name of the table to check
 * @param {string} columnName - Name of the column to check for
 * @returns {Promise<boolean>} True if the column exists
 */
async function hasColumn(connection, tableName, columnName) {
  const [rows] = await connection.query(
    `
      SELECT 1
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
      LIMIT 1
    `,
    [tableName, columnName],
  );

  return rows.length > 0;
}

/**
 * Internal function that runs the actual ALTER TABLE migrations.
 * Uses the provided connection (either from a transaction or a fresh pool connection).
 *
 * @param {object} connection - Active MySQL connection
 */
async function ensureFinancialColumnsWithConnection(connection) {
  // ── Check products.net_profit ──────────────────────────────────────────────
  const productHasNetProfit = await hasColumn(
    connection,
    "products",
    "net_profit",
  );
  if (!productHasNetProfit) {
    // Add net_profit column AFTER the price column for logical ordering in schema
    await connection.query(`
      ALTER TABLE products
      ADD COLUMN net_profit DECIMAL(10,2) NOT NULL DEFAULT 0.00
      AFTER price
    `);
  }

  const productHasOriginalPrice = await hasColumn(
    connection,
    "products",
    "original_price",
  );
  if (!productHasOriginalPrice) {
    await connection.query(`
      ALTER TABLE products
      ADD COLUMN original_price DECIMAL(10,2) NOT NULL DEFAULT 0.00
      AFTER net_profit
    `);

    // Backfill list/original price from legacy selling price + stored margin.
    await connection.query(`
      UPDATE products
      SET original_price = price + net_profit
      WHERE original_price = 0 AND (price > 0 OR net_profit > 0)
    `);

    // Legacy old_price stored the pre-discount list price — convert to discount amount.
    await connection.query(`
      UPDATE products
      SET old_price = old_price - price
      WHERE old_price IS NOT NULL AND old_price > price
    `);
  }

  // ── Check products.base_selling_price ─────────────────────────────────────
  // base_selling_price = the selling price set by the admin at product creation.
  // This column is NEVER overwritten when category discounts are applied.
  // It provides a stable, non-accumulating baseline so that changing a category
  // discount from 10% to 20% always calculates on the original price (not the
  // already-discounted price), eliminating the compounding discount bug.
  const productHasBaseSellingPrice = await hasColumn(
    connection,
    "products",
    "base_selling_price",
  );
  if (!productHasBaseSellingPrice) {
    await connection.query(`
      ALTER TABLE products
      ADD COLUMN base_selling_price DECIMAL(10,2) NOT NULL DEFAULT 0.00
      AFTER original_price
    `);

    // Backfill: reconstruct original selling price from current data.
    // old_price stores the accumulated discount amount, so:
    //   base_selling_price = current_price + discount_amount
    await connection.query(`
      UPDATE products
      SET base_selling_price = price + COALESCE(old_price, 0)
      WHERE base_selling_price = 0
    `);
  }

  // ── Check order_items.unit_net_profit ──────────────────────────────────────
  const orderItemsHaveUnitNetProfit = await hasColumn(
    connection,
    "order_items",
    "unit_net_profit",
  );
  if (!orderItemsHaveUnitNetProfit) {
    // Add unit_net_profit AFTER price so schema reads logically
    await connection.query(`
      ALTER TABLE order_items
      ADD COLUMN unit_net_profit DECIMAL(10,2) NOT NULL DEFAULT 0.00
      AFTER price
    `);
  }
}

/**
 * Public API: Ensures the financial columns exist before any query that needs them.
 *
 * Two call modes:
 *  1. `ensureFinancialColumns(connection)` — Uses the provided connection
 *     (use this when inside a transaction so the check runs atomically)
 *  2. `ensureFinancialColumns()` — Acquires its own connection from the pool
 *     and uses a module-level singleton promise to avoid running more than once
 *
 * @param {object|null} [connection=null] - Optional active MySQL connection
 */
export async function ensureFinancialColumns(connection = null) {
  if (connection) {
    // When called with an explicit connection (within a transaction), run immediately
    await ensureFinancialColumnsWithConnection(connection);
    return;
  }

  // When called without a connection, use/create the singleton promise
  // This ensures the migration is only attempted ONCE across all concurrent requests
  if (!ensureFinancialColumnsPromise) {
    ensureFinancialColumnsPromise = (async () => {
      const managedConnection = await db.getConnection();
      try {
        await ensureFinancialColumnsWithConnection(managedConnection);
      } finally {
        managedConnection.release(); // Always release back to pool
      }
    })().catch((error) => {
      // Reset to null on failure so the next request can retry
      ensureFinancialColumnsPromise = null;
      throw error;
    });
  }

  await ensureFinancialColumnsPromise;
}
