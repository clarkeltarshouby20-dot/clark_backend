import { Router } from "express";
import { verifyToken, verifyAdminOrOwner } from "../middlewares/auth.js";
import {
  lookupProductByBarcode,
  sellPosCart,
  returnPosSale,
  getPosSalesList,
  getPosSaleDetails,
  getPosSaleByReceipt,
} from "../controllers/pos.controllers.js";

const router = Router();

router.use(verifyToken, verifyAdminOrOwner);

router.get("/products/barcode/:code", lookupProductByBarcode);
router.post("/sales", sellPosCart);
router.post("/returns", returnPosSale);
router.get("/sales", getPosSalesList);
router.get("/sales/receipt/:number", getPosSaleByReceipt);
router.get("/sales/:id", getPosSaleDetails);

export default router;
