import { Router } from "express";
import upload from "../middlewares/upload.js";
import { verifyToken, verifyAdminOrOwner } from "../middlewares/auth.js";
import {
  createCategory,
  getAllCategories,
  getCategoriesWithProducts,
  getMostVisitedCategories,
  recordCategoryVisit,
  getCategoryById,
  updateCategory,
  deleteCategory,
  getCategoryByIdWithProducts,
  applyCategoryDiscount,
} from "../controllers/category.controllers.js";

const router = Router();

// ── Public ─────────────────────────────────────────────────────────
router.get("/", getAllCategories);
router.get("/with-products", getCategoriesWithProducts);
router.get("/most-visited", getMostVisitedCategories);
router.post("/:id/visit", recordCategoryVisit);
router.get("/:id", getCategoryById);
router.get("/:id/with-products", getCategoryByIdWithProducts);

// ── Protected: admin or owner only ─────────────────────────────────
router.post(
  "/",
  verifyToken,
  verifyAdminOrOwner,
  upload.single("image_url"),
  createCategory,
);
router.patch(
  "/:id",
  verifyToken,
  verifyAdminOrOwner,
  upload.single("image_url"),
  updateCategory,
);
router.put(
  "/:id",
  verifyToken,
  verifyAdminOrOwner,
  upload.single("image_url"),
  updateCategory,
);
router.delete("/:id", verifyToken, verifyAdminOrOwner, deleteCategory);
router.post(
  "/:id/apply-discount",
  verifyToken,
  verifyAdminOrOwner,
  applyCategoryDiscount,
);

export default router;
