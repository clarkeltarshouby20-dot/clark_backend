/**
 * @file settingsSchema.js
 * @description Lazy schema migration for site_settings social fields.
 */

import db from "../config/db.js";

let ensureSettingsSchemaPromise = null;

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

async function ensureSettingsSchemaWithConnection(connection) {
  const hasInstagram = await hasColumn(connection, "site_settings", "social_instagram");
  if (!hasInstagram) {
    await connection.query(`
      ALTER TABLE site_settings
      ADD COLUMN social_instagram VARCHAR(255) DEFAULT ''
      AFTER social_facebook
    `);
  }
}

export async function ensureSettingsSchema(connection = null) {
  if (connection) {
    await ensureSettingsSchemaWithConnection(connection);
    return;
  }

  if (!ensureSettingsSchemaPromise) {
    ensureSettingsSchemaPromise = (async () => {
      const managedConnection = await db.getConnection();
      try {
        await ensureSettingsSchemaWithConnection(managedConnection);
      } finally {
        managedConnection.release();
      }
    })().catch((error) => {
      ensureSettingsSchemaPromise = null;
      throw error;
    });
  }

  await ensureSettingsSchemaPromise;
}
