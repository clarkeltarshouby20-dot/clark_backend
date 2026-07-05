/**
 * @file expenseSchema.js
 * @description Lazy schema migration for business expenses tracking.
 */

import db from "../config/db.js";

let ensureExpenseSchemaPromise = null;

async function ensureExpenseSchemaWithConnection(connection) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS expenses (
      id INT AUTO_INCREMENT PRIMARY KEY,
      amount DECIMAL(10,2) NOT NULL,
      created_by INT DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_expenses_created_at (created_at)
    )
  `);
}

export async function ensureExpenseSchema(connection = null) {
  if (connection) {
    await ensureExpenseSchemaWithConnection(connection);
    return;
  }

  if (!ensureExpenseSchemaPromise) {
    ensureExpenseSchemaPromise = (async () => {
      const managedConnection = await db.getConnection();
      try {
        await ensureExpenseSchemaWithConnection(managedConnection);
      } finally {
        managedConnection.release();
      }
    })().catch((error) => {
      ensureExpenseSchemaPromise = null;
      throw error;
    });
  }

  await ensureExpenseSchemaPromise;
}
