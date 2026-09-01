import multer from "multer";
import type { NextFunction, Request, Response } from "express";

/**
 * Single-image multipart parsing, shared by every route that accepts a chart
 * image: the manual upload/paste endpoint and the two generated-chart
 * endpoints, where the browser now renders the chart itself and posts it.
 *
 * Memory storage: the bytes go straight from the request into a Buffer and on
 * into Supabase Storage, so the API never writes uploads to disk. The size
 * limit matches the chart-images bucket's own file_size_limit.
 */

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const ALLOWED_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];

/** File extension to store a given image under; the storage key carries one. */
export function extensionForMimeType(mimetype: string): string {
  if (mimetype === "image/jpeg") return "jpg";
  if (mimetype === "image/webp") return "webp";
  return "png";
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES },
});

/**
 * Runs multer's single-file parse and converts its failures into 400s here.
 *
 * Multer reports errors — including LIMIT_FILE_SIZE for an oversized file — via
 * an error-first callback rather than a thrown exception, so mounting
 * upload.single('image') directly as middleware would hand those errors to an
 * Express error handler instead of the route. No global error handler exists
 * yet, and these routes must not depend on one being added later.
 *
 * The file itself is optional here — a route that requires one says so — but
 * a file that IS present must be an image type we can store and send to the
 * model, so that check belongs to every caller and lives here.
 */
export function handleImageUpload(req: Request, res: Response, next: NextFunction): void {
  upload.single("image")(req, res, (err: unknown) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        res.status(400).json({ error: "File exceeds the 5MB limit" });
        return;
      }
      res.status(400).json({ error: "Upload error" });
      return;
    }

    // Trust boundary: this MVP validates the client-supplied mimetype only. It
    // does not inspect file bytes (no magic-byte/signature check), so a client
    // that lies about Content-Type can get non-image bytes stored under an image
    // extension. Acceptable for MVP because the bucket is private and nothing
    // currently executes or publicly serves this content; revisit with a library
    // like `file-type` before broadening exposure (public URLs, wider sharing…).
    if (req.file && !ALLOWED_IMAGE_MIME_TYPES.includes(req.file.mimetype)) {
      res.status(400).json({ error: "Unsupported image type" });
      return;
    }

    next();
  });
}
