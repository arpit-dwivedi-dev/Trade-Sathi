import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { logger } from "../lib/logger.js";
import { requireAuth } from "../middleware/auth.js";
import { processAnalysis } from "../services/ai-analysis.service.js";
import { createAnalysis } from "../services/analysis.service.js";

export const analysesRouter = Router();

const MAX_FILE_BYTES = 5 * 1024 * 1024;

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];

const SOURCE_TYPES = ["paste", "upload"];

// Memory storage: the bytes go straight from the request into a Buffer and on
// into Supabase Storage, so the API never writes uploads to disk. The size
// limit matches the chart-images bucket's own file_size_limit.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
});

/**
 * Runs multer's single-file parse and converts its failures into 400s here.
 *
 * Multer reports errors — including LIMIT_FILE_SIZE for an oversized file — via
 * an error-first callback rather than a thrown exception, so mounting
 * upload.single('image') directly as middleware would hand those errors to an
 * Express error handler instead of this route. No global error handler exists
 * yet, and this route must not depend on one being added later.
 */
function handleUpload(req: Request, res: Response, next: NextFunction): void {
  upload.single("image")(req, res, (err: unknown) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        res.status(400).json({ error: "File exceeds the 5MB limit" });
        return;
      }
      res.status(400).json({ error: "Upload error" });
      return;
    }
    next();
  });
}

analysesRouter.post(
  "/api/analyses",
  requireAuth,
  handleUpload,
  async (req: Request, res: Response) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "Missing image file" });
      return;
    }

    // Trust boundary: this MVP validates the client-supplied mimetype only. It
    // does not inspect file bytes (no magic-byte/signature check), so a client
    // that lies about Content-Type can get non-image bytes stored under an image
    // extension. Acceptable for MVP because the bucket is private and nothing
    // currently executes or publicly serves this content; revisit with a library
    // like `file-type` before broadening exposure (public URLs, wider sharing…).
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      res.status(400).json({ error: "Unsupported image type" });
      return;
    }

    // Both values are transported identically — a pasted chart image (Ctrl+V in
    // the browser) still arrives here as ordinary multipart file bytes, same as
    // a file-picker upload. sourceType is purely a UX-origin tag for future
    // analytics (which interaction produced this image), not a different payload
    // shape or a different validation path. Do not add logic that treats 'paste'
    // differently from 'upload' at this endpoint.
    const sourceType: unknown = req.body?.sourceType;
    if (typeof sourceType !== "string" || !SOURCE_TYPES.includes(sourceType)) {
      res.status(400).json({ error: "sourceType must be 'paste' or 'upload'" });
      return;
    }

    try {
      // Non-null: requireAuth ran before this handler and only calls next()
      // after setting profileId.
      const result = await createAnalysis(
        req.profileId!,
        { buffer: file.buffer, mimetype: file.mimetype },
        sourceType as "paste" | "upload",
      );

      if (!result.ok) {
        // 402 Payment Required, deliberately chosen over 429: this signals
        // "upgrade needed", not "retry shortly". The frontend should route the
        // user to the upgrade flow rather than backing off and retrying.
        res.status(402).json({ error: "Monthly analysis quota exceeded" });
        return;
      }

      // Deliberately fire-and-forget for the MVP: the response must return
      // immediately with status 'queued', so this is not awaited. The trade-off
      // is that if the Node process restarts between this call and completion,
      // that analysis stays stuck at 'queued' forever with no automatic retry.
      // Acceptable for now; a durable queue (e.g. BullMQ) is the real fix and is
      // out of scope here. processAnalysis() never rejects, by contract.
      void processAnalysis(result.id);

      res.status(201).json({ id: result.id, status: result.status });
    } catch (cause) {
      logger.error("failed to create analysis", { cause: String(cause) });
      res.status(500).json({ error: "Failed to create analysis" });
    }
  },
);
