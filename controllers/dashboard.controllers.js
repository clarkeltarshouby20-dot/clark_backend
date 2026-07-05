/**
 * @file dashboard.controllers.js
 * @description Admin dashboard statistics controller.
 *
 * Provides a single aggregate endpoint that runs multiple queries in parallel
 * using Promise.all — minimizing response time by avoiding sequential DB calls.
 *
 * Statistics returned:
 *  - total_orders        — Total number of orders ever placed
 *  - delivered_revenue   — Net revenue (online delivered + POS sales minus POS returns)
 *  - delivered_net_profit — Net profit (online + POS; returns stored as negative)
 *  - total_returns       — Count of returned orders (+ POS return transactions)
 *  - total_pos_sales     — POS sale receipts with remaining non-returned items
 *  - pending_payments    — Count of orders awaiting payment verification
 *  - total_products      — Total product count
 *  - total_users         — Total user count (only visible to the "owner" role)
 *  - recent_orders       — Last 10 orders (for the dashboard activity feed)
 *
 * Role-Based Data Visibility:
 *  - total_users is returned as null for admins (only owner sees user count)
 *  - Net profit data is calculated from order_items.unit_net_profit (snapshot at order time)
 *    falling back to products.net_profit if the snapshot is missing
 */

import db from "../config/db.js";
import { ensureFinancialColumns } from "../utils/financialSchema.js";
import { ensurePosSchema } from "../utils/posSchema.js";
import { ensureExpenseSchema } from "../utils/expenseSchema.js";

// ── getDashboardStats ──────────────────────────────────────────────────────────
/**
 * GET /api/dashboard
 *
 * Fetches all dashboard KPIs in a single request using parallel queries.
 * All 7 queries are fired concurrently via Promise.all for minimal latency.
 *
 * Revenue vs Net Profit:
 *  - Revenue = what was charged to customers (total_price on delivered orders)
 *  - Net Profit = revenue minus costs (unit_net_profit stored per order item at time of order)
 *
 * @route  GET /api/dashboard
 * @access Protected — Admin or Owner only (verifyAdminOrOwner at route level)
 */
export const getDashboardStats = async (req, res, next) => {
  try {
    // Ensure the net_profit and unit_net_profit columns exist before querying
    // (added by ensureFinancialColumns if missing — schema migration guard)
    await ensureFinancialColumns();
    await ensurePosSchema();
    await ensureExpenseSchema();

    // Only the "owner" gets to see the total user count
    const isOwner = req.user?.role === "owner";

    // Date Filters
    const { start_date, end_date } = req.query;
    let orderDateSql = "";
    let posDateSql = "";
    let expenseDateSql = "";
    let userDateSql = "";
    let productDateSql = "";
    let params = [];

    if (start_date && end_date) {
      orderDateSql = " AND o.created_at BETWEEN ? AND ?";
      posDateSql = " AND ps.created_at BETWEEN ? AND ?";
      expenseDateSql = " AND created_at BETWEEN ? AND ?";
      userDateSql = " WHERE created_at BETWEEN ? AND ?";
      productDateSql = " WHERE created_at BETWEEN ? AND ?";
      params = [new Date(start_date), new Date(end_date)];
    }

    // ── Run all queries in parallel for better performance ──────────────────
    const [
      [orderCountRows],    // Total orders ever placed
      [revenueRows],       // Total revenue from delivered orders
      [netProfitRows],     // Net profit from delivered orders
      [returnsRows],       // Count of returned orders
      [pendingPaymentRows],// Orders waiting for payment verification
      [productRows],       // Total product count
      [recentOrders],      // 10 most recent orders (for activity feed)
      [userRows],          // Total user count (owner-only)
      [posStatsRows],      // POS net revenue, profit, returns
      [activePosSalesRows],// POS sales with remaining items
      [expenseRows],       // Total expenses
    ] = await Promise.all([
      db.query(`SELECT COUNT(*) AS total_orders FROM orders o WHERE 1=1 ${orderDateSql}`, params),

      // Only count revenue from fully delivered orders
      db.query(`
        SELECT COALESCE(SUM(o.total_price), 0) AS delivered_revenue
        FROM orders o
        WHERE o.status = 'delivered' ${orderDateSql}
      `, params),

      // Net profit scaled by actual collected amount vs list price (coupon / discount aware)
      db.query(`
        SELECT COALESCE(
          SUM(
            COALESCE(oi.unit_net_profit, p.net_profit, 0) * oi.quantity *
            CASE
              WHEN order_gross.gross_total > 0 THEN o.total_price / order_gross.gross_total
              ELSE 1
            END
          ),
          0
        ) AS delivered_net_profit
        FROM order_items oi
        INNER JOIN orders o ON o.id = oi.order_id
        LEFT JOIN products p ON p.id = oi.product_id
        INNER JOIN (
          SELECT order_id, SUM(price * quantity) AS gross_total
          FROM order_items
          GROUP BY order_id
        ) order_gross ON order_gross.order_id = o.id
        WHERE o.status = 'delivered' ${orderDateSql}
      `, params),

      db.query(`
        SELECT COUNT(*) AS total_returns
        FROM orders o
        WHERE o.status = 'returned' ${orderDateSql}
      `, params),

      // Count orders where payment hasn't been confirmed yet
      db.query(`
        SELECT COUNT(*) AS pending_payments
        FROM orders o
        WHERE o.payment_status IN ('pending', 'pending_verification') ${orderDateSql}
      `, params),

      db.query(`SELECT COUNT(*) AS total_products FROM products${productDateSql}`, params),

      // Recent 10 orders with user info for the activity table
      db.query(`
        SELECT
          o.id,
          o.status,
          o.payment_status,
          o.total_price,
          o.created_at,
          u.name,
          u.email
        FROM orders o
        LEFT JOIN users u ON u.id = o.user_id
        WHERE 1=1 ${orderDateSql}
        ORDER BY o.created_at DESC
        LIMIT 10
      `, params),

      // User count only for owner — otherwise return a placeholder promise
      isOwner
        ? db.query(`SELECT COUNT(*) AS total_users FROM users ${userDateSql}`, params)
        : Promise.resolve([[{ total_users: null }]]),

      db.query(`
        SELECT
          COALESCE(SUM(
            CASE
              WHEN ps.transaction_type = 'sale' THEN ps.final_total
              WHEN ps.transaction_type = 'return' THEN -ps.final_total
              ELSE 0
            END
          ), 0) AS pos_net_revenue,
          COALESCE(SUM(
            CASE
              WHEN ps.transaction_type = 'return' THEN -1
              ELSE 1
            END *
            CASE
              WHEN ps.subtotal_before_discount > 0 THEN LEAST(
                ps.final_total,
                (
                  SELECT COALESCE(SUM(psi.unit_net_profit * psi.quantity), 0)
                  FROM pos_sale_items psi
                  WHERE psi.pos_sale_id = ps.id
                ) * ps.final_total / ps.subtotal_before_discount
              )
              ELSE 0
            END
          ), 0) AS pos_net_profit,
          COALESCE(SUM(CASE WHEN ps.transaction_type = 'return' THEN 1 ELSE 0 END), 0) AS pos_returns
        FROM pos_sales ps
        WHERE 1=1 ${posDateSql}
      `, params),

      db.query(`
        SELECT COUNT(DISTINCT ps.id) AS active_pos_sales
        FROM pos_sales ps
        INNER JOIN pos_sale_items psi ON psi.pos_sale_id = ps.id
        WHERE ps.transaction_type = 'sale'
          AND psi.quantity > COALESCE(psi.returned_quantity, 0)
          ${posDateSql}
      `, params),

      db.query(`
        SELECT COALESCE(SUM(amount), 0) AS total_expenses
        FROM expenses
        WHERE 1=1 ${expenseDateSql}
      `, params),
    ]);

    const posStats = posStatsRows[0] || {};
    const onlineRevenue = Number(revenueRows[0]?.delivered_revenue || 0);
    const posNetRevenue = Number(posStats.pos_net_revenue || 0);
    const onlineNetProfit = Number(netProfitRows[0]?.delivered_net_profit || 0);
    const posNetProfit = Number(posStats.pos_net_profit || 0);

    res.status(200).json({
      success: true,
      data: {
        total_orders: Number(orderCountRows[0]?.total_orders || 0),
        delivered_revenue: onlineRevenue + posNetRevenue,
        delivered_net_profit: onlineNetProfit + posNetProfit,
        total_returns:
          Number(returnsRows[0]?.total_returns || 0) +
          Number(posStats.pos_returns || 0),
        total_pos_sales: Number(activePosSalesRows[0]?.active_pos_sales || 0),
        total_expenses: Number(expenseRows[0]?.total_expenses || 0),
        pending_payments: Number(pendingPaymentRows[0]?.pending_payments || 0),
        total_products: Number(productRows[0]?.total_products || 0),
        // null = user is an admin (not owner), undefined values become null in JSON
        total_users:
          userRows[0]?.total_users === null
            ? null
            : Number(userRows[0]?.total_users || 0),
        recent_orders: recentOrders,
      },
    });
  } catch (error) {
    next(error);
  }
};
