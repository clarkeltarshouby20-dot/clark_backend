import dotenv from "dotenv";
import db from "../config/db.js";
import { ensurePosSchema } from "../utils/posSchema.js";

dotenv.config();

const conn = await db.getConnection();
try {
  await ensurePosSchema();
  const [cols] = await conn.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS 
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'barcode'`,
  );
  console.log("barcode column:", cols.length ? "exists" : "MISSING");
  const [sample] = await conn.query(
    "SELECT id, name, barcode FROM products ORDER BY id DESC LIMIT 8",
  );
  console.log("recent products:", sample);
  const [[stats]] = await conn.query(
    "SELECT COUNT(*) AS total, SUM(CASE WHEN barcode IS NULL OR barcode = '' THEN 1 ELSE 0 END) AS missing FROM products",
  );
  console.log("stats:", stats);
} catch (error) {
  console.error("check failed:", error.message);
} finally {
  conn.release();
  process.exit(0);
}
