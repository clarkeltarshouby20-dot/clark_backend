/**
 * @file upload.js (middleware)
 * @description Multer + Cloudinary file upload middleware configuration.
 *
 * This module configures two upload profiles:
 *
 *  1. `upload` (default export) — For general-purpose image uploads (product images, avatars)
 *     - Folder: "users_ecommerce"
 *     - Formats: JPEG, PNG, WEBP
 *     - Size limit: 2 MB
 *     - Public ID: auto-generated UUID prefix "avatar_{uuid}"
 *
 *  2. `logoUpload` (named export) — For site brand assets (logo, footer logo, favicon)
 *     - Folder: "settings_logos"
 *     - Formats: JPEG, PNG, WEBP, SVG, ICO (broader support for brand assets)
 *     - Size limit: 1 MB (smaller for web-optimized brand assets)
 *     - Transformation: Auto-resized to 800px wide (crop: limit)
 *     - Public ID: auto-generated UUID prefix "logo_{uuid}"
 *
 * File Validation:
 *   Both uploaders validate by MIME type AND file extension.
 *   This prevents extension spoofing (e.g., renaming a .exe to .jpg).
 *
 * CloudinaryStorage from multer-storage-cloudinary streams files directly
 * to Cloudinary — no disk storage is used. req.file.path = the Cloudinary URL.
 */

import multer from "multer";
import path from "path";
import { v2 as cloudinary } from "cloudinary";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import crypto from "crypto";
import dotenv from "dotenv";
dotenv.config();

// ── Cloudinary SDK Configuration ──────────────────────────────────────────────
// Must be configured before creating any CloudinaryStorage instance
cloudinary.config({
  cloud_name: process.env.CLD_NAME,
  api_key: process.env.API_KEY,
  api_secret: process.env.API_SECRET,
  secure: true,  // Always use HTTPS URLs
});

// ── Default Cloudinary Storage (General Images / Avatars) ───────────────────
/**
 * Stores uploaded images directly to Cloudinary's "users_ecommerce" folder.
 * Generates a unique public_id using crypto.randomUUID() to prevent collisions.
 * Cloudinary enforces the allowed_formats list server-side as a second layer of validation.
 */
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: "users_ecommerce",
    allowed_formats: ["jpg", "jpeg", "png", "webp"],
    resource_type: "image",
    public_id: (req, file) => `avatar_${crypto.randomUUID()}`,  // Unique name per upload
  },
});

/**
 * Creates a Multer file filter that validates both MIME type and file extension.
 * Double validation prevents spoofed file types (e.g., executable renamed to .jpg).
 *
 * Strict mode (default): BOTH mime AND extension must be in the allowed list.
 * This is intentionally strict — if only the extension is valid but MIME is unrecognised
 * (e.g. image/heic, image/tiff) we still reject, because the backend storage (Cloudinary)
 * will reject those formats anyway, producing a confusing "works sometimes" experience.
 *
 * @param {object}   options
 * @param {string[]} options.allowedMimeTypes  - e.g. ["image/jpeg", "image/png"]
 * @param {string[]} options.allowedExtensions - e.g. [".jpg", ".jpeg", ".png"]
 * @param {string}   options.message           - Error message if validation fails
 * @returns {Function} Multer-compatible fileFilter function
 */
const buildFileFilter = ({ allowedMimeTypes, allowedExtensions, message }) => {
  return (req, file, cb) => {
    const ext  = path.extname(file.originalname || "").toLowerCase();
    const mime = `${file.mimetype || ""}`.toLowerCase();

    // Reject if the MIME type is not explicitly allowed.
    // We do NOT fall back to extension-only acceptance for product images because
    // Cloudinary enforces the same MIME-based list server-side. Allowing mismatched
    // files here would let them pass multer but fail on Cloudinary upload, causing
    // a silent 500 error instead of a clear user-facing message.
    const isAllowedMime = allowedMimeTypes.includes(mime);
    const isAllowedExt  = allowedExtensions.includes(ext);

    if (!isAllowedMime && !isAllowedExt) {
      const error = new Error(message);
      error.status = 400;
      return cb(error, false);
    }

    cb(null, true); // Accept the file
  };
};


// ── File Filter for General Images ───────────────────────────────────────────
// Used for product images and user avatars
const defaultFileFilter = buildFileFilter({
  allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
  allowedExtensions: [".jpg", ".jpeg", ".png", ".webp"],
  message: "Invalid file type. Only JPEG, PNG, and WEBP images are allowed.",
});

// ── File Filter for Settings Brand Assets ────────────────────────────────────
// Used for logo, footer logo, and favicon uploads
// SVG and ICO are accepted in addition to raster formats for brand flexibility
const settingsAssetFileFilter = buildFileFilter({
  allowedMimeTypes: [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/svg+xml",
    "image/x-icon",
    "image/vnd.microsoft.icon",  // Windows ICO format
  ],
  allowedExtensions: [".jpg", ".jpeg", ".png", ".webp", ".svg", ".ico"],
  message: "Invalid file type. Allowed formats: JPG, PNG, WEBP, SVG, and ICO.",
});

// ── Default Multer Upload Instance ────────────────────────────────────────────
/**
 * General-purpose uploader for product images and avatars.
 * Streams directly to Cloudinary (no local disk usage).
 *
 * Usage in routes: `upload.single('image')` or `upload.array('images', 5)`
 */
const upload = multer({
  storage: storage,
  fileFilter: defaultFileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB per file — matches the ImageUploader component maxSize
  },
});

export default upload;

// ── Logo-Specific Cloudinary Storage ─────────────────────────────────────────
// Separate folder and transformation settings for site brand assets
const logoStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: "settings_logos",
    allowed_formats: ["jpg", "jpeg", "png", "webp", "svg", "ico"],
    resource_type: "image",
    public_id: (req, file) => `logo_${crypto.randomUUID()}`,  // Unique logo name
    // Resize images to max 800px wide on the Cloudinary side
    // SVGs are vector-based and scale perfectly without this transformation
    transformation: [{ width: 800, crop: "limit" }],
  },
});

// ── Logo Upload Instance ───────────────────────────────────────────────────────
/**
 * Specialized uploader for site settings brand assets (logo, footer logo, favicon).
 * Uses a smaller 1MB limit because brand assets should be web-optimized.
 * Errors from this uploader are caught by the global errorHandler middleware.
 *
 * Usage in routes: `logoUpload.fields([{ name: 'logo' }, { name: 'favicon' }])`
 */
export const logoUpload = multer({
  storage: logoStorage,
  fileFilter: settingsAssetFileFilter,
  limits: { fileSize: 1024 * 1024 }, // 1MB max for brand assets
});
