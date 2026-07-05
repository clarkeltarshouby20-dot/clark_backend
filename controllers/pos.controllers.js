/**
 * @file pos.controllers.js
 * @description HTTP handlers for POS operations.
 */

import {
  createPosSale,
  createPosReturn,
  getPosSaleById,
  getPosSaleByReceiptNumber,
  listPosSales,
  getProductByBarcode,
} from "../services/posSaleService.js";

export async function lookupProductByBarcode(req, res, next) {
  try {
    const product = await getProductByBarcode(req.params.code);
    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found for this barcode.",
      });
    }

    res.status(200).json({
      success: true,
      message: "Product found.",
      data: product,
    });
  } catch (error) {
    next(error);
  }
}

export async function sellPosCart(req, res, next) {
  try {
    const sale = await createPosSale({
      cashierId: req.user.id,
      items: req.body.items,
      cartDiscountType: req.body.cart_discount_type,
      cartDiscountValue: req.body.cart_discount_value,
    });

    res.status(201).json({
      success: true,
      message: "Sale completed successfully.",
      data: sale,
    });
  } catch (error) {
    next(error);
  }
}

export async function returnPosSale(req, res, next) {
  try {
    const sale = await createPosReturn({
      cashierId: req.user.id,
      receiptNumber: req.body.receipt_number,
      items: req.body.items,
    });

    res.status(201).json({
      success: true,
      message: "Return processed successfully.",
      data: sale,
    });
  } catch (error) {
    next(error);
  }
}

export async function getPosSalesList(req, res, next) {
  try {
    const page = Number.parseInt(req.query.page, 10) || 1;
    const limit = Number.parseInt(req.query.limit, 10) || 20;
    const result = await listPosSales({
      page,
      limit,
      search: req.query.search || "",
      dateFrom: req.query.date_from || "",
      dateTo: req.query.date_to || "",
    });

    res.status(200).json({
      success: true,
      message: "POS sales fetched successfully.",
      data: result.sales,
      pagination: result.pagination,
    });
  } catch (error) {
    next(error);
  }
}

export async function getPosSaleDetails(req, res, next) {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const sale = await getPosSaleById(id);

    if (!sale) {
      return res.status(404).json({
        success: false,
        message: "POS sale not found.",
      });
    }

    res.status(200).json({
      success: true,
      message: "POS sale fetched successfully.",
      data: sale,
    });
  } catch (error) {
    next(error);
  }
}

export async function getPosSaleByReceipt(req, res, next) {
  try {
    const sale = await getPosSaleByReceiptNumber(req.params.number);

    if (!sale) {
      return res.status(404).json({
        success: false,
        message: "Receipt not found.",
      });
    }

    res.status(200).json({
      success: true,
      message: "Receipt fetched successfully.",
      data: sale,
    });
  } catch (error) {
    next(error);
  }
}
