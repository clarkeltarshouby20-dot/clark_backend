/**
 * @file inventoryMovementService.js
 * @description Records inventory movement audit entries.
 */

export async function logInventoryMovements(
  connection,
  { items, reason, referenceType, referenceId, createdBy },
) {
  if (!items?.length) return;

  const values = items.map((item) => [
    item.product_id,
    item.variant_id || null,
    item.quantity_delta,
    reason,
    referenceType,
    referenceId,
    createdBy || null,
  ]);

  await connection.query(
    `
      INSERT INTO inventory_movements (
        product_id, variant_id, quantity_delta, reason,
        reference_type, reference_id, created_by
      ) VALUES ?
    `,
    [values],
  );
}
