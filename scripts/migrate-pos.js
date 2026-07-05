/**
 * One-time migration script for POS schema + barcode backfill.
 * Run: node server/scripts/migrate-pos.js
 */

import dotenv from "dotenv";
import { ensurePosSchema } from "../utils/posSchema.js";

dotenv.config();

async function main() {
  await ensurePosSchema();
  console.log("POS migration completed successfully.");
}

main().catch((error) => {
  console.error("POS migration failed:", error);
  process.exit(1);
});
