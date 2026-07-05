/**
 * @file settings.controllers.js
 * @description Global Site Settings and Configuration Manager.
 *
 * This controller manages the single global settings row (`site_settings` table, ID=1).
 * It dictates the appearance, business logic, and integrations of the entire platform.
 * 
 * Capabilities:
 *  - Dynamic UI configuration (Site Name, Currencies, Social Links).
 *  - Marketing Integrations (Google Analytics IDs, Custom raw Scripts).
 *  - Shipping configuration (Valid governorates and delivery costs).
 *  - Asset Management: Uploads logos and automatically deletes old assets from Cloudinary
 *    to prevent orphaned files and save storage space.
 */

import db from "../config/db.js";
import { v2 as cloudinary } from "cloudinary";
import { normalizeGovernorates } from "../utils/egyptGovernorates.js";
import { decodeHtmlEntities } from "../utils/html.js";
import { ensureSettingsSchema } from "../utils/settingsSchema.js";

function normalizeCurrencyCode(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!normalized || normalized === "USD") {
    return "EGP";
  }
  return normalized;
}

function normalizeSettingsAssets(row = {}) {
  return {
    ...row,
    currency_code: normalizeCurrencyCode(row.currency_code),
    logo_url: decodeHtmlEntities(row.logo_url || ""),
    footer_logo_url: decodeHtmlEntities(row.footer_logo_url || ""),
    favicon_url: decodeHtmlEntities(row.favicon_url || ""),
    hero_image_url: decodeHtmlEntities(row.hero_image_url || ""),
  };
}

function buildSettingsPayload(source = {}, old = {}) {
  return {
    site_name: source.site_name?.trim() || old.site_name || "",
    currency_code: normalizeCurrencyCode(
      source.currency_code || old.currency_code,
    ),
    contact_email: source.contact_email?.trim() || old.contact_email || "",
    whatsapp_number: source.whatsapp_number?.trim() || old.whatsapp_number || "",
    google_analytics_id:
      source.google_analytics_id?.trim() || old.google_analytics_id || "",
    google_ads_client_id:
      source.google_ads_client_id?.trim() || old.google_ads_client_id || "",
    header_scripts: source.header_scripts ?? old.header_scripts ?? "",
    footer_scripts: source.footer_scripts ?? old.footer_scripts ?? "",
    social_facebook: source.social_facebook?.trim() || old.social_facebook || "",
    social_instagram: source.social_instagram?.trim() || old.social_instagram || "",
    social_x: source.social_x?.trim() || old.social_x || "",
    social_whatsapp: source.social_whatsapp?.trim() || old.social_whatsapp || "",
    social_telegram: source.social_telegram?.trim() || old.social_telegram || "",
    social_gmail: source.social_gmail?.trim() || old.social_gmail || "",
    wallet_number: source.wallet_number?.trim() || old.wallet_number || "",
    instapay_handle: source.instapay_handle?.trim() || old.instapay_handle || "",
    shipping_governorates: JSON.stringify(
      normalizeGovernorates(
        source.shipping_governorates ?? old.shipping_governorates,
      ),
    ),
  };
}

function resolveAsset(req, old, fieldName, dbField, bodyField) {
  if (req.files?.[fieldName]?.[0]?.path) {
    return req.files[fieldName][0].path;
  }
  if (req.body?.[bodyField]?.trim()) {
    return decodeHtmlEntities(req.body[bodyField].trim());
  }
  return decodeHtmlEntities(old[dbField] || "");
}

async function cleanupCloudinary(newPath, oldUrl) {
  if (!newPath || !oldUrl || !oldUrl.includes("cloudinary.com")) return;

  try {
    const parts = oldUrl.split("/");
    const filenameWithExt = parts.pop();
    const folder = parts.pop();
    const filename = filenameWithExt.split(".")[0];
    const publicId = `${folder}/${filename}`;
    await cloudinary.uploader.destroy(publicId);
  } catch (error) {
    console.warn("[settings] Cloudinary cleanup failed:", error.message);
  }
}

/**
 * GET /api/settings
 * 
 * Fetches the global application settings. 
 * Requested heavily by the frontend on initial load to configure themes, currencies, and tracking scripts.
 *
 * @route   GET /api/settings
 * @access  Public
 */
const getSettings = async (_req, res, next) => {
  try {
    await ensureSettingsSchema();
    const [rows] = await db.query("SELECT * FROM site_settings LIMIT 1");
    const settings = normalizeSettingsAssets(rows[0] || {});
    settings.shipping_governorates = normalizeGovernorates(
      settings.shipping_governorates,
    );

    res.status(200).json({
      success: true,
      message: "Settings fetched successfully",
      data: settings,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * PUT /api/settings
 * 
 * Master update endpoint for all general site settings.
 * Accepts both text fields and multipart files (Logos/Favicons).
 * 
 * Features:
 *  - Dynamic Upsert: Checks if ID=1 exists. If so, updates it. If not, creates it.
 *  - Automatic Cloudinary Garbage Collection: When a new logo is uploaded, 
 *    the old logo URL is extracted and deleted permanently from the Cloudinary bucket.
 *
 * @route   PUT /api/settings
 * @access  Protected (Owner only - strictest security level)
 */
const updateSettings = async (req, res, next) => {
  try {
    await ensureSettingsSchema();
    const [existingRows] = await db.query("SELECT * FROM site_settings LIMIT 1");
    const old = normalizeSettingsAssets(existingRows[0] || {});

    const merged = buildSettingsPayload(req.body || {}, old);
    merged.logo_url = resolveAsset(req, old, "logo", "logo_url", "logo_url");
    merged.footer_logo_url = resolveAsset(
      req,
      old,
      "footer_logo",
      "footer_logo_url",
      "footer_logo_url",
    );
    merged.favicon_url = resolveAsset(
      req,
      old,
      "favicon",
      "favicon_url",
      "favicon_url",
    );
    merged.hero_image_url = resolveAsset(
      req,
      old,
      "hero_image",
      "hero_image_url",
      "hero_image_url",
    );

    await cleanupCloudinary(req.files?.logo?.[0]?.path, old.logo_url);
    await cleanupCloudinary(
      req.files?.footer_logo?.[0]?.path,
      old.footer_logo_url,
    );
    await cleanupCloudinary(req.files?.favicon?.[0]?.path, old.favicon_url);
    await cleanupCloudinary(req.files?.hero_image?.[0]?.path, old.hero_image_url);

    const cols = Object.keys(merged);
    const vals = Object.values(merged);

    if (!old.id) {
      const colList = cols.join(", ");
      const placeholders = cols.map(() => "?").join(", ");
      await db.query(
        `INSERT INTO site_settings (${colList}) VALUES (${placeholders})`,
        vals,
      );
    } else {
      const setClause = cols.map((column) => `${column} = ?`).join(", ");
      await db.query(
        `UPDATE site_settings SET ${setClause} WHERE id = ?`,
        [...vals, old.id],
      );
    }

    const [rows] = await db.query("SELECT * FROM site_settings LIMIT 1");
    return res.status(200).json({
      success: true,
      message: "Settings updated successfully",
      data: {
        ...normalizeSettingsAssets(rows[0] || {}),
        shipping_governorates: normalizeGovernorates(
          rows[0]?.shipping_governorates,
        ),
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * PUT /api/settings/shipping
 * 
 * Partially updates ONLY the shipping governorates array.
 * Separated from the main settings update route because shipping locations
 * are managed within their own distinct UI tab inside the Admin Dashboard.
 *
 * @route   PUT /api/settings/shipping
 * @access  Protected (Owner only)
 */
const updateShippingSettings = async (req, res, next) => {
  try {
    const [existingRows] = await db.query("SELECT * FROM site_settings LIMIT 1");
    const old = normalizeSettingsAssets(existingRows[0] || {});
    const shippingGovernorates = JSON.stringify(
      normalizeGovernorates(req.body.shipping_governorates),
    );

    if (!old.id) {
      await db.query(
        "INSERT INTO site_settings (id, shipping_governorates) VALUES (1, ?)",
        [shippingGovernorates],
      );
    } else {
      await db.query(
        "UPDATE site_settings SET shipping_governorates = ? WHERE id = ?",
        [shippingGovernorates, old.id],
      );
    }

    const [rows] = await db.query("SELECT * FROM site_settings LIMIT 1");
    return res.status(200).json({
      success: true,
      message: "Shipping settings updated successfully",
      data: {
        ...normalizeSettingsAssets(rows[0] || {}),
        shipping_governorates: normalizeGovernorates(
          rows[0]?.shipping_governorates,
        ),
      },
    });
  } catch (error) {
    next(error);
  }
};

export { getSettings, updateSettings, updateShippingSettings };
