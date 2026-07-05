/**
 * @file posBarcodeService.js
 * @description CODE128-compatible barcode generation for products.
 */

function computeCheckDigit(base) {
  const digits = base.replace(/\D/g, "");
  if (!digits.length) return "0";

  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    const weight = i % 2 === 0 ? 3 : 1;
    sum += Number(digits[i]) * weight;
  }

  return String((10 - (sum % 10)) % 10);
}

export function generateBarcodeForProductId(productId) {
  const padded = String(productId).padStart(8, "0");
  const base = `CL${padded}`;
  return `${base}${computeCheckDigit(base)}`;
}

export async function assignBarcodeToProduct(connection, productId) {
  let barcode = generateBarcodeForProductId(productId);
  let attempts = 0;

  while (attempts < 5) {
    try {
      await connection.query("UPDATE products SET barcode = ? WHERE id = ?", [
        barcode,
        productId,
      ]);
      return barcode;
    } catch (error) {
      if (error.code === "ER_DUP_ENTRY") {
        barcode = `${generateBarcodeForProductId(productId)}${attempts + 1}`;
        attempts += 1;
      } else {
        throw error;
      }
    }
  }

  const error = new Error("Unable to generate a unique barcode.");
  error.status = 500;
  throw error;
}
