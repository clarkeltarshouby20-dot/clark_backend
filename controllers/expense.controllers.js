/**
 * @file expense.controllers.js
 * @description CRUD for business expenses (amount-only entries).
 */

import db from "../config/db.js";
import { ensureExpenseSchema } from "../utils/expenseSchema.js";

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

function parseAmount(value) {
  const amount = roundMoney(value);
  if (Number.isNaN(amount) || amount <= 0) {
    const error = new Error("Amount must be greater than zero.");
    error.status = 400;
    throw error;
  }
  return amount;
}

function buildDateFilter(query) {
  const { start_date, end_date } = query;
  if (!start_date || !end_date) {
    return { sql: "", params: [] };
  }
  return {
    sql: " AND created_at BETWEEN ? AND ?",
    params: [new Date(start_date), new Date(end_date)],
  };
}

export const listExpenses = async (req, res, next) => {
  try {
    await ensureExpenseSchema();
    const { sql, params } = buildDateFilter(req.query);

    const [items] = await db.query(
      `SELECT id, amount, created_at, updated_at
       FROM expenses
       WHERE 1=1 ${sql}
       ORDER BY created_at DESC, id DESC`,
      params,
    );

    const [totalRows] = await db.query(
      `SELECT COALESCE(SUM(amount), 0) AS total_expenses
       FROM expenses
       WHERE 1=1 ${sql}`,
      params,
    );

    res.status(200).json({
      success: true,
      data: {
        items,
        total_expenses: Number(totalRows[0]?.total_expenses || 0),
      },
    });
  } catch (error) {
    next(error);
  }
};

export const createExpense = async (req, res, next) => {
  try {
    await ensureExpenseSchema();
    const amount = parseAmount(req.body?.amount);
    const createdBy = req.user?.id || null;

    const [result] = await db.query(
      "INSERT INTO expenses (amount, created_by) VALUES (?, ?)",
      [amount, createdBy],
    );

    const [rows] = await db.query(
      "SELECT id, amount, created_at, updated_at FROM expenses WHERE id = ?",
      [result.insertId],
    );

    res.status(201).json({
      success: true,
      message: "Expense added successfully.",
      data: rows[0],
    });
  } catch (error) {
    next(error);
  }
};

export const updateExpense = async (req, res, next) => {
  try {
    await ensureExpenseSchema();
    const { id } = req.params;
    const amount = parseAmount(req.body?.amount);

    const [existing] = await db.query("SELECT id FROM expenses WHERE id = ?", [id]);
    if (!existing.length) {
      return res.status(404).json({ success: false, message: "Expense not found." });
    }

    await db.query("UPDATE expenses SET amount = ? WHERE id = ?", [amount, id]);

    const [rows] = await db.query(
      "SELECT id, amount, created_at, updated_at FROM expenses WHERE id = ?",
      [id],
    );

    res.status(200).json({
      success: true,
      message: "Expense updated successfully.",
      data: rows[0],
    });
  } catch (error) {
    next(error);
  }
};

export const deleteExpense = async (req, res, next) => {
  try {
    await ensureExpenseSchema();
    const { id } = req.params;

    const [result] = await db.query("DELETE FROM expenses WHERE id = ?", [id]);
    if (!result.affectedRows) {
      return res.status(404).json({ success: false, message: "Expense not found." });
    }

    res.status(200).json({
      success: true,
      message: "Expense deleted successfully.",
    });
  } catch (error) {
    next(error);
  }
};
