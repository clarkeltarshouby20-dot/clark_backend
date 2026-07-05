/**
 * @file posSchema.js
 * @description Lazy schema migration for POS tables and product barcodes.
 */

import db from "../config/db.js";
import {
  assignBarcodeToProduct,
} from "../services/posBarcodeService.js";

let ensurePosSchemaPromise = null;

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

async function hasIndex(connection, tableName, indexName) {
  const [rows] = await connection.query(
    `
      SELECT 1
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND INDEX_NAME = ?
      LIMIT 1
    `,
    [tableName, indexName],
  );
  return rows.length > 0;
}

async function hasTable(connection, tableName) {
  const [rows] = await connection.query(
    `
      SELECT 1
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
      LIMIT 1
    `,
    [tableName],
  );
  return rows.length > 0;
}

async function backfillMissingBarcodes(connection) {
  const [rows] = await connection.query(
    "SELECT id FROM products WHERE barcode IS NULL OR barcode = '' ORDER BY id ASC",
  );

  for (const row of rows) {
    await assignBarcodeToProduct(connection, row.id);
  }
}

async function ensureProductsBarcodeColumn(connection) {
  const productHasBarcode = await hasColumn(connection, "products", "barcode");
  if (!productHasBarcode) {
    // TiDB Cloud does not support ADD COLUMN ... UNIQUE in one statement.
    await connection.query(`
      ALTER TABLE products
      ADD COLUMN barcode VARCHAR(32) NULL
    `);
  }

  await backfillMissingBarcodes(connection);

  const hasBarcodeIndex = await hasIndex(connection, "products", "uk_products_barcode");
  if (!hasBarcodeIndex) {
    try {
      await connection.query(`
        CREATE UNIQUE INDEX uk_products_barcode ON products (barcode)
      `);
    } catch (error) {
      if (error.code !== "ER_DUP_ENTRY" && error.errno !== 1061) {
        throw error;
      }
    }
  }
}

async function ensurePosSchemaWithConnection(connection) {
  await ensureProductsBarcodeColumn(connection);

  const posSalesExists = await hasTable(connection, "pos_sales");
  if (!posSalesExists) {
    await connection.query(`
      CREATE TABLE pos_sales (
        id INT NOT NULL AUTO_INCREMENT,
        receipt_number VARCHAR(32) NOT NULL,
        transaction_type ENUM('sale','return') NOT NULL DEFAULT 'sale',
        original_sale_id INT DEFAULT NULL,
        cashier_id INT NOT NULL,
        subtotal_before_discount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        items_discount_total DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        cart_discount_type ENUM('none','percent','fixed') NOT NULL DEFAULT 'none',
        cart_discount_value DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        cart_discount_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        final_total DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        total_net_profit DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        payment_method ENUM('cash') NOT NULL DEFAULT 'cash',
        items_count INT NOT NULL DEFAULT 0,
        status ENUM('completed') NOT NULL DEFAULT 'completed',
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uk_pos_sales_receipt (receipt_number),
        KEY idx_pos_sales_cashier (cashier_id),
        KEY idx_pos_sales_original (original_sale_id),
        KEY idx_pos_sales_created (created_at),
        CONSTRAINT fk_pos_sales_cashier FOREIGN KEY (cashier_id) REFERENCES users (id),
        CONSTRAINT fk_pos_sales_original FOREIGN KEY (original_sale_id) REFERENCES pos_sales (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  const posSaleItemsExists = await hasTable(connection, "pos_sale_items");
  if (!posSaleItemsExists) {
    await connection.query(`
      CREATE TABLE pos_sale_items (
        id INT NOT NULL AUTO_INCREMENT,
        pos_sale_id INT NOT NULL,
        product_id INT NOT NULL,
        variant_id INT DEFAULT NULL,
        product_name VARCHAR(150) NOT NULL,
        selected_size VARCHAR(20) DEFAULT NULL,
        selected_color_name VARCHAR(80) DEFAULT NULL,
        selected_color_value VARCHAR(20) DEFAULT NULL,
        selected_image_url VARCHAR(255) DEFAULT NULL,
        quantity INT NOT NULL,
        returned_quantity INT NOT NULL DEFAULT 0,
        original_unit_price DECIMAL(10,2) NOT NULL,
        item_discount_type ENUM('none','percent','fixed') NOT NULL DEFAULT 'none',
        item_discount_value DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        item_discount_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        final_unit_price DECIMAL(10,2) NOT NULL,
        line_subtotal DECIMAL(10,2) NOT NULL,
        unit_net_profit DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        PRIMARY KEY (id),
        KEY idx_pos_sale_items_sale (pos_sale_id),
        KEY idx_pos_sale_items_product (product_id),
        KEY idx_pos_sale_items_variant (variant_id),
        CONSTRAINT fk_pos_sale_items_sale FOREIGN KEY (pos_sale_id) REFERENCES pos_sales (id) ON DELETE CASCADE,
        CONSTRAINT fk_pos_sale_items_product FOREIGN KEY (product_id) REFERENCES products (id),
        CONSTRAINT pos_sale_items_chk_qty CHECK (quantity > 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  const inventoryMovementsExists = await hasTable(connection, "inventory_movements");
  if (!inventoryMovementsExists) {
    await connection.query(`
      CREATE TABLE inventory_movements (
        id INT NOT NULL AUTO_INCREMENT,
        product_id INT NOT NULL,
        variant_id INT DEFAULT NULL,
        quantity_delta INT NOT NULL,
        reason ENUM('pos_sale','pos_return','online_order','order_cancel','order_return') NOT NULL,
        reference_type ENUM('pos_sale','order') NOT NULL,
        reference_id INT NOT NULL,
        created_by INT DEFAULT NULL,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_inv_mov_product (product_id),
        KEY idx_inv_mov_reference (reference_type, reference_id),
        CONSTRAINT fk_inv_mov_product FOREIGN KEY (product_id) REFERENCES products (id),
        CONSTRAINT fk_inv_mov_created_by FOREIGN KEY (created_by) REFERENCES users (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }
}

export async function ensurePosSchema(connection = null) {
  // DDL must run outside active transactions (TiDB/MySQL implicit commit).
  if (connection) {
    const error = new Error(
      "ensurePosSchema must not run inside a transaction. Call ensurePosSchema() without a connection.",
    );
    error.status = 500;
    throw error;
  }

  if (!ensurePosSchemaPromise) {
    ensurePosSchemaPromise = (async () => {
      const managedConnection = await db.getConnection();
      try {
        await ensurePosSchemaWithConnection(managedConnection);
      } finally {
        managedConnection.release();
      }
    })().catch((error) => {
      ensurePosSchemaPromise = null;
      throw error;
    });
  }

  await ensurePosSchemaPromise;
}
