/**
 * @file error.js (middleware)
 * @description Global Express error handler.
 *
 * This middleware is the last line of defense before a 500 response is sent.
 * All controllers pass errors to next(error) which routes them here.
 *
 * Behavior:
 *  - Logs error details server-side (always)
 *  - In development: Returns full error details (message + stack + code) for debugging
 *  - In production: Returns a safe generic message to avoid leaking implementation details
 *   (e.g., database schema, file paths, stack traces)
 *
 * Special cases handled:
 *  - MulterError (LIMIT_FILE_SIZE): Returns 400 with a user-friendly message
 *  - "Invalid file type" errors: Returns 400
 *  - All other errors: Returns err.status or 500
 *
 * Must be registered AFTER all routes in the Express app (index.js).
 */

/**
 * Express error-handling middleware.
 * The 4-argument signature is required — Express recognizes this as an error handler.
 *
 * @param {Error}    err  - The error object passed to next(err)
 * @param {object}   req  - Express request
 * @param {object}   res  - Express response
 * @param {Function} next - Express next (unused but required by Express signature)
 */
export const errorHandler = (err, req, res, next) => {
  const isDev = process.env.NODE_ENV === "development";

  // Always log the error server-side for debugging
  // Vercel's observability dashboard will capture these console.error logs
  console.error(`[ERROR] ${req.method} ${req.path} - ${err.message}`);
  if (isDev || err.status === 500) {
    // Print full stack trace in development, or for unexpected 500s in production
    console.error(err.stack);
  }

  // Determine the HTTP status code and message to send
  let statusCode = err.status || 500;
  let message = err.message || "Something went wrong on our side!";

  // ── Multer File Upload Errors ────────────────────────────────────
  // Multer throws MulterError for things like exceeding the file size limit
  if (err.name === "MulterError") {
    statusCode = 400;
    if (err.code === "LIMIT_FILE_SIZE") {
      // Provide a clear user-facing message explaining the size limit based on path
      if (req.originalUrl?.includes("/products") || req.path?.includes("/products")) {
        message = "File is too large. Maximum size allowed is 5MB for product images.";
      } else {
        message = "File is too large. Maximum size allowed is 1MB for site brand assets.";
      }
    } else {
      message = `Upload error: ${err.message}`;
    }
  } else if (err.message?.includes("Invalid file type")) {
    // Custom file filter errors from upload.js throw errors with this message prefix
    statusCode = 400;
  }

  // ── Build the JSON response ──────────────────────────────────────
  // In production, replace generic 500 messages with a safe, non-leaking message
  const errorResponse = {
    success: false,
    message: statusCode === 500 && !isDev ? "An internal server error occurred" : message,
  };

  // In development, attach extra debugging info (stack trace, error code, raw message)
  // NEVER expose these details in production
  if (isDev) {
    errorResponse.debug = {
      message: err.message,
      stack: err.stack,
      ...(err.code ? { code: err.code } : {}),
    };
  }

  res.status(statusCode).json(errorResponse);
};
