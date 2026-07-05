/**
 * @file index.js
 * @description Main Express application entry point for the Clark Market API.
 *
 * This file is responsible for:
 *  1. Loading environment variables via dotenv
 *  2. Initializing the Express app with all required middleware
 *  3. Configuring CORS to allow only trusted origins (development + Vercel)
 *  4. Registering all feature-specific API route modules under /api
 *  5. Attaching global error handling and 404 fallback
 *  6. Starting the HTTP server in non-production environments
 *     (in production/Vercel, the app is exported as a serverless function)
 *
 * Architecture: MEVN stack — MySQL / Express / Vue / Node.js
 */

// ── Imports ───────────────────────────────────────────────────────
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import { errorHandler } from "./middlewares/error.js";
import { apiLimiter, csrfCheck } from "./middlewares/security.js";
import { sanitizeData } from "./middlewares/sanitizer.js";

// Load .env before anything else so all process.env values are available
dotenv.config();

// ── Route files ───────────────────────────────────────────────────
// Each module encapsulates routes for its domain resource
import userRoutes from "./routes/user.routes.js";
import categoryRoutes from "./routes/category.routes.js";
import productRoutes from "./routes/product.routes.js";
import settingsRoutes from "./routes/settings.routes.js";
import ordersRoutes from "./routes/orders.routes.js";
import paymentsRoutes from "./routes/payments.routes.js";
import reviewsRoutes from "./routes/reviews.routes.js";
import messagesRoutes from "./routes/messages.routes.js";
import couponRoutes from "./routes/coupon.routes.js";
import wishlistRoutes from "./routes/wishlist.routes.js";
import dashboardRoutes from "./routes/dashboard.routes.js";
import posRoutes from "./routes/pos.routes.js";
import expenseRoutes from "./routes/expense.routes.js";
import { ensurePosSchema } from "./utils/posSchema.js";

// ── App ───────────────────────────────────────────────────────────
const app = express();

// Trust the first reverse proxy (Vercel, Nginx, etc.)
// Required for express-rate-limit to use the real client IP from X-Forwarded-For
app.set("trust proxy", 1);

// ── CORS ──────────────────────────────────────────────────────────
// Build the whitelist from FRONTEND_URL env var (comma-separated) + localhost
const frontendUrls = (process.env.FRONTEND_URL || "")
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);

const allowedOrigins = [
  "http://localhost:5173",    // Vite dev server
  "http://127.0.0.1:5173",   // Vite dev server (IP variant)
  ...frontendUrls             // Production URLs from env
].map(origin => origin.replace(/\/$/, "")); // Remove trailing slashes for consistent comparison

console.log("🛡️ CORS Whitelist:", allowedOrigins);

const corsOptions = {
  /**
   * Dynamic origin check:
   *  - Requests without an origin header (curl, mobile apps) are allowed
   *  - Explicitly whitelisted origins are allowed
   *  - Any *.vercel.app subdomain is allowed (preview deploys)
   *  - All other origins are rejected
   */
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);
    
    const normalizedOrigin = origin.replace(/\/$/, "");
    
    const isWhitelisted = allowedOrigins.includes(normalizedOrigin);
    const isVercelSubdomain = normalizedOrigin.endsWith(".vercel.app");

    if (isWhitelisted || isVercelSubdomain) {
      callback(null, true);
    } else {
      console.error(`[CORS REJECTED] Origin: ${origin} | Not in Whitelist and not a Vercel subdomain.`);
      callback(new Error(`Not allowed by CORS: ${origin}`));
    }
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type", 
    "Authorization", 
    "X-Requested-With",  // Required by csrfCheck middleware
    "X-CSRF-Token"       // Added for CSRF protection layer
  ],
  credentials: true,           // Allow cookies (HttpOnly JWT token)
  optionsSuccessStatus: 200,   // Some legacy browsers choke on 204
};

app.use(cors(corsOptions));

// ── Core middleware ────────────────────────────────────────────────

// Helmet: Sets security-focused HTTP response headers
// Configured with a CSP that allows our Cloudinary images and Google Fonts
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],  // Allow essential inline scripts
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        imgSrc: ["'self'", "data:", "https://res.cloudinary.com"], // Allow Cloudinary images
        connectSrc: ["'self'"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        objectSrc: ["'none'"],        // Disallow <object>, <embed>, <applet>
        upgradeInsecureRequests: [],
      },
    },
  })
);

// Morgan: HTTP request logger (dev format shows method, path, status, response time)
app.use(morgan("dev"));

// cookieParser: Parses Cookie header into req.cookies (needed for HttpOnly JWT)
app.use(cookieParser());

// Parse JSON request bodies
app.use(express.json());

// Parse URL-encoded request bodies (HTML form submissions)
app.use(express.urlencoded({ extended: true }));

// ── Security Middleware (applied globally to all /api routes) ──────

// Rate limiting: 10,000 requests per 15 min (high to support Lighthouse testing)
app.use("/api", apiLimiter);

// CSRF check: Ensures all write requests include X-Requested-With header
// This prevents cross-site form hijacking since browsers block custom headers cross-origin
app.use("/api", csrfCheck);

// Input sanitization: Escapes HTML entities in req.body, req.query, req.params
// Protects against XSS. Some trusted fields (scripts, descriptions) are whitelisted.
app.use("/api", sanitizeData);

// ── Routes ────────────────────────────────────────────────────────
// Use a sub-router to group all feature routes under /api
const router = express.Router();

router.use("/users", userRoutes);           // Auth + profile management
router.use("/categories", categoryRoutes);  // Product categories
router.use("/products", productRoutes);     // Product catalog + search
router.use("/orders", ordersRoutes);        // Order lifecycle management
router.use("/payments", paymentsRoutes);    // Payment verification flow
router.use("/settings", settingsRoutes);    // Site settings (logo, scripts, shipping)
router.use("/reviews", reviewsRoutes);      // Product reviews
router.use("/messages", messagesRoutes);    // Contact Us form messages
router.use("/coupons", couponRoutes);       // Discount coupon management
router.use("/wishlist", wishlistRoutes);    // User wishlist (saved products)
router.use("/dashboard", dashboardRoutes);  // Admin dashboard statistics
router.use("/pos", posRoutes);              // In-store POS sales
router.use("/expenses", expenseRoutes);    // Business expenses

// Mount the sub-router — all routes are prefixed with /api
app.use("/api", router);

// ── 404 Fallback ──────────────────────────────────────────────────
// Any request that doesn't match a defined route gets a clear 404 JSON response
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

// ── Global Error Handler ──────────────────────────────────────────
// Must be registered AFTER all routes. Handles next(error) calls from controllers.
app.use(errorHandler);

// ── Start Server ─────────────────────────────────────────────────
// In production (Vercel serverless), the app is exported as a function handler.
// In development, we start a local HTTP server.
const PORT = process.env.PORT || 5001;

if (process.env.NODE_ENV !== "production") {
  app.listen(PORT, async () => {
    try {
      await ensurePosSchema();
      console.log("✅ POS schema ready (barcode column + tables).");
    } catch (error) {
      console.error("⚠️ POS schema migration failed:", error.message);
    }
    console.log(`✅ Local server running on http://localhost:${PORT}`);
    console.log("Connecting to:", process.env.DB_HOST);
  });
}

// Export the app for Vercel's serverless runtime
export default app;
