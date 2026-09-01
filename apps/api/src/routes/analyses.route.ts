import { Router, type Request, type Response } from "express";
import { asyncRoute } from "../lib/async-route.js";
import { logger } from "../lib/logger.js";
import { handleImageUpload } from "../middleware/image-upload.js";
import { requireAuth } from "../middleware/auth.js";
import { processAnalysis } from "../services/ai-analysis.service.js";
import { createAnalysis } from "../services/analysis.service.js";

export const analysesRouter = Router();

const SOURCE_TYPES = ["paste", "upload"];

analysesRouter.post(
  "/api/analyses",
  asyncRoute(requireAuth),
  handleImageUpload,
  asyncRoute(async (req: Request, res: Response) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "Missing image file" });
      return;
    }

    // Both values are transported identically — a pasted chart image (Ctrl+V in
    // the browser) still arrives here as ordinary multipart file bytes, same as
    // a file-picker upload. sourceType is purely a UX-origin tag for future
    // analytics (which interaction produced this image), not a different payload
    // shape or a different validation path. Do not add logic that treats 'paste'
    // differently from 'upload' at this endpoint.
    const body: unknown = req.body;
    const sourceType: unknown =
      typeof body === "object" && body !== null
        ? (body as { sourceType?: unknown }).sourceType
        : undefined;
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

      // A 'complete' result is a dedupe hit: createAnalysis recognised these
      // exact image bytes from one of this user's earlier analyses and returned
      // that row instead of storing and processing a second copy. There is
      // nothing to dispatch — the row is already finished.
      if (result.status === "queued") {
        // Deliberately fire-and-forget for the MVP: the response must return
        // immediately with status 'queued', so this is not awaited. If the Node
        // process restarts between this call and completion, the row is left at
        // 'queued'; the startup/interval sweep in jobs/stranded-analyses.job.ts
        // is what reclaims it. A durable queue (e.g. BullMQ) remains the real
        // fix. processAnalysis() never rejects, by contract.
        void processAnalysis(result.id);
      }

      res.status(201).json({ id: result.id, status: result.status });
    } catch (cause) {
      logger.error("failed to create analysis", { cause: String(cause) });
      res.status(500).json({ error: "Failed to create analysis" });
    }
  }),
);
