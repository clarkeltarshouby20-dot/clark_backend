/**
 * @file categorySchema.js
 * @description Lazy schema migration for category-level discount metadata.
 */

import db from "../config/db.js";

let ensureCategorySchemaPromise = null;

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

async function ensureCategorySchemaWithConnection(connection) {
  const hasDiscountType = await hasColumn(connection, "categories", "discount_type");
  if (!hasDiscountType) {
    await connection.query(`
      ALTER TABLE categories
      ADD COLUMN discount_type VARCHAR(20) NOT NULL DEFAULT 'none'
      AFTER sort_order
    `);
  }

  const hasDiscountValue = await hasColumn(connection, "categories", "discount_value");
  if (!hasDiscountValue) {
    await connection.query(`
      ALTER TABLE categories
      ADD COLUMN discount_value DECIMAL(10,2) DEFAULT NULL
      AFTER discount_type
    `);
  }

  const hasVisitCount = await hasColumn(connection, "categories", "visit_count");
  if (!hasVisitCount) {
    await connection.query(`
      ALTER TABLE categories
      ADD COLUMN visit_count INT NOT NULL DEFAULT 0
      AFTER discount_value
    `);
  }
}

export async function ensureCategorySchema(connection = null) {
  if (connection) {
    await ensureCategorySchemaWithConnection(connection);
    return;
  }

  if (!ensureCategorySchemaPromise) {
    ensureCategorySchemaPromise = (async () => {
      const managedConnection = await db.getConnection();
      try {
        await ensureCategorySchemaWithConnection(managedConnection);
      } finally {
        managedConnection.release();
      }
    })().catch((error) => {
      ensureCategorySchemaPromise = null;
      throw error;
    });
  }

  await ensureCategorySchemaPromise;
}
