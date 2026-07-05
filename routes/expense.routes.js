import { Router } from "express";
import {
  listExpenses,
  createExpense,
  updateExpense,
  deleteExpense,
} from "../controllers/expense.controllers.js";
import { verifyAdminOrOwner, verifyToken } from "../middlewares/auth.js";

const router = Router();

router.get("/", verifyToken, verifyAdminOrOwner, listExpenses);
router.post("/", verifyToken, verifyAdminOrOwner, createExpense);
router.put("/:id", verifyToken, verifyAdminOrOwner, updateExpense);
router.delete("/:id", verifyToken, verifyAdminOrOwner, deleteExpense);

export default router;
