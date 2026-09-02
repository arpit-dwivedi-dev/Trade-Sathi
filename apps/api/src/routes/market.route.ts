import { Router, type Request, type Response } from "express";
import { asyncRoute } from "../lib/async-route.js";
import { MarketDataError } from "../lib/market-data/types.js";
import { logger } from "../lib/logger.js";
import { handleImageUpload } from "../middleware/image-upload.js";
import { requireAuth } from "../middleware/auth.js";
import { analyzeInstrumentLive } from "../services/live-analysis.service.js";
import {
  explicitCandleSpec,
  fetchInstrumentById,
  getCandlesForInstrument,
  getQuoteForInstrument,
  WORKSPACE_INTERVALS,
  type WorkspaceInterval,
} from "../services/market-chart.service.js";

/**
 * Market data for the live chart view. The candles/quote reads are proxied
 * through here rather than fetched from the browser because the upstream
 * provider is server-side only (no CORS, no per-user key) and because this is
 * where the shared TTL cache lives — see market-chart.service.
 */
export const marketRouter = Router();

const MIN_LOOKBACK_DAYS = 1;
const MAX_LOOKBACK_DAYS = 365;

function parseLookbackDays(raw: unknown): number | null {
  const value = Number(typeof raw === "string" ? raw : NaN);
  if (!Number.isInteger(value)) return null;
  if (value < MIN_LOOKBACK_DAYS || value > MAX_LOOKBACK_DAYS) return null;
  return value;
}

/** Explicit timeframe for the manual charting workspace; absent for the Live tab's derived-from-lookback behaviour. */
function parseInterval(raw: unknown): WorkspaceInterval | null {
  if (typeof raw !== "string") return null;
  return (WORKSPACE_INTERVALS as readonly string[]).includes(raw) ? (raw as WorkspaceInterval) : null;
}

/** Upstream failures are the provider's, not the caller's: 502, not 500. */
function sendMarketDataError(res: Response, cause: unknown, context: string): void {
  if (cause instanceof MarketDataError) {
    if (cause.reason === "not_found") {
      res.status(404).json({ error: "Instrument not available from the market-data provider" });
      return;
    }
    logger.error(context, { reason: cause.reason, cause: String(cause) });
    res.status(502).json({ error: "Market data is temporarily unavailable" });
    return;
  }
  logger.error(context, { cause: String(cause) });
  res.status(500).json({ error: "Market data request failed" });
}

marketRouter.get(
  "/api/market/candles",
  asyncRoute(requireAuth),
  asyncRoute(async (req: Request, res: Response) => {
    const instrumentId =
      typeof req.query["instrumentId"] === "string" ? req.query["instrumentId"] : "";
    const lookbackDays = parseLookbackDays(req.query["lookbackDays"]);
    const hasInterval = req.query["interval"] !== undefined;
    const interval = parseInterval(req.query["interval"]);

    if (!instrumentId || lookbackDays === null || (hasInterval && interval === null)) {
      res.status(400).json({
        error: `instrumentId and lookbackDays (1-365) are required; interval, if given, must be one of ${WORKSPACE_INTERVALS.join("/")}`,
      });
      return;
    }

    try {
      const ref = await fetchInstrumentById(instrumentId);
      if (!ref) {
        res.status(404).json({ error: "Instrument not found" });
        return;
      }

      const window = await getCandlesForInstrument(
        ref,
        lookbackDays,
        interval ? explicitCandleSpec(interval) : undefined,
      );
      res.json({
        instrument: {
          id: ref.instrumentId,
          symbol: ref.symbol,
          name: ref.name,
          exchange: ref.exchange,
        },
        timeframeLabel: window.timeframeLabel,
        intervalMinutes: window.intervalMinutes,
        marketDataDate: window.marketDataDate,
        candles: window.candles,
      });
    } catch (cause) {
      sendMarketDataError(res, cause, "live candles request failed");
    }
  }),
);

marketRouter.get(
  "/api/market/quote",
  asyncRoute(requireAuth),
  asyncRoute(async (req: Request, res: Response) => {
    const instrumentId =
      typeof req.query["instrumentId"] === "string" ? req.query["instrumentId"] : "";
    if (!instrumentId) {
      res.status(400).json({ error: "instrumentId is required" });
      return;
    }

    try {
      const ref = await fetchInstrumentById(instrumentId);
      if (!ref) {
        res.status(404).json({ error: "Instrument not found" });
        return;
      }
      const quote = await getQuoteForInstrument(ref);
      res.json({ lastPrice: quote.lastPrice, asOf: quote.asOf });
    } catch (cause) {
      sendMarketDataError(res, cause, "live quote request failed");
    }
  }),
);

/**
 * Starts a live analysis. The request is multipart because the browser sends
 * the chart it drew, which is stored with the analysis for the user to view —
 * see ChartCaptureService on the web side. The image is display-only (the
 * analysis reads the candle data) and optional: without one the API renders
 * its own chart instead.
 */
marketRouter.post(
  "/api/market/analyze",
  asyncRoute(requireAuth),
  handleImageUpload,
  asyncRoute(async (req: Request, res: Response) => {
    const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as {
      instrumentId?: unknown;
      lookbackDays?: unknown;
    };
    const instrumentId = typeof body.instrumentId === "string" ? body.instrumentId : "";
    // Multipart carries every field as text, so the number arrives as a string
    // here where the previous JSON body delivered a real number.
    const lookbackDays = Number(
      typeof body.lookbackDays === "number" || typeof body.lookbackDays === "string"
        ? body.lookbackDays
        : Number.NaN,
    );

    try {
      // Non-null: requireAuth ran before this handler and only calls next()
      // after setting profileId.
      const result = await analyzeInstrumentLive(
        req.profileId!,
        instrumentId,
        lookbackDays,
        req.file ? { buffer: req.file.buffer, mimetype: req.file.mimetype } : null,
      );

      if (result.ok) {
        // 202: the pipeline runs in the background. analysisId names the
        // 'queued' row it will fill in, which is what the client watches —
        // including for a 'failed' status, so a failure surfaces immediately
        // instead of as a client-side timeout.
        res.status(202).json({
          analysisId: result.analysisId,
          instrumentId: result.instrumentId,
          startedAt: result.startedAt,
        });
        return;
      }

      switch (result.reason) {
        case "invalid_lookback":
          res.status(400).json({ error: "lookbackDays must be an integer between 1 and 365" });
          return;
        case "not_found":
          res.status(404).json({ error: "Instrument not found" });
          return;
        case "quota_exceeded":
          // 402, matching the manual-upload convention in analyses.route.ts.
          res.status(402).json({ error: "Monthly analysis quota exceeded" });
          return;
      }
    } catch (cause) {
      logger.error("live analyze request failed", { cause: String(cause) });
      res.status(500).json({ error: "Could not start analysis" });
    }
  }),
);
