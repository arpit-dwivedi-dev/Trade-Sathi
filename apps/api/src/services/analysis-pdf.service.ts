import sharp from "sharp";
import {
  buildAnalysisPdf,
  pdfFileNameFor,
  type AnalysisPdfImage,
  type AnalysisPdfPattern,
  type AnalysisPdfRow,
} from "../lib/pdf/analysis-pdf.js";
import { logger } from "../lib/logger.js";
import { supabaseAdmin } from "../lib/supabase.js";

const BUCKET = "chart-images";

/** One rendered analysis, ready to hand to the mailer. */
export interface AnalysisPdfAttachment {
  filename: string;
  content: Buffer;
}

/** The columns buildAnalysisPdf reads, named once so the select cannot drift. */
const PDF_COLUMNS = [
  "symbol",
  "symbol_raw",
  "asset_class",
  "timeframe",
  "source_type",
  "status",
  "trend",
  "volatility",
  "volume_reading",
  "sentiment",
  "support_levels",
  "resistance_levels",
  "call_direction",
  "call_confidence",
  "call_entry",
  "call_invalidation",
  "call_target",
  "horizon_candles",
  "summary",
  "created_at",
  "image_key",
].join(", ");

/**
 * Downloads the chart image and measures it — jsPDF needs both the bytes and
 * the aspect ratio to place the picture.
 *
 * Dimensions come from `sharp`, which is already a dependency for rendering
 * these charts in the first place; Node has no createImageBitmap for the
 * browser copy's approach. Returns null rather than throwing: a missing chart
 * must not cost the reader the rest of the document, exactly as on the web.
 */
async function loadChartImage(imageKey: string | null): Promise<AnalysisPdfImage | null> {
  if (!imageKey) return null;

  try {
    const { data, error } = await supabaseAdmin.storage.from(BUCKET).download(imageKey);
    if (error || !data) throw error ?? new Error("Storage returned no object");

    const bytes = Buffer.from(await data.arrayBuffer());
    const { width, height, format } = await sharp(bytes).metadata();
    if (!width || !height) throw new Error("Chart image has no intrinsic size");

    // jsPDF names JPEG 'JPEG', never 'JPG'; sharp reports 'jpeg'.
    const named = (format ?? "png").toUpperCase();
    const jsPdfFormat = named === "JPG" ? "JPEG" : named;

    return {
      dataUrl: `data:image/${format ?? "png"};base64,${bytes.toString("base64")}`,
      format: jsPdfFormat,
      width,
      height,
    };
  } catch (cause) {
    logger.error("chart image could not be embedded in the PDF", {
      imageKey,
      cause: String(cause),
    });
    return null;
  }
}

/**
 * Renders a stored analysis as a PDF attachment.
 *
 * Reads the persisted `analyses` row rather than taking the in-memory AI
 * result: the emailed PDF is then the same document the History tab's Download
 * button produces, from the same columns, and cannot show a value that was
 * never stored.
 *
 * Returns null on any failure — the caller sends the email without this
 * attachment. A briefing that arrives with its HTML body intact is worth far
 * more than one withheld because a PDF could not be drawn.
 */
export async function buildAnalysisPdfAttachment(
  analysisId: string,
): Promise<AnalysisPdfAttachment | null> {
  try {
    const [analysis, patterns] = await Promise.all([
      supabaseAdmin
        .from("analyses")
        .select(PDF_COLUMNS)
        .eq("id", analysisId)
        .single<AnalysisPdfRow & { image_key: string | null }>(),
      supabaseAdmin
        .from("analysis_patterns")
        .select("pattern_key, confidence, pattern_note")
        .eq("analysis_id", analysisId)
        .returns<AnalysisPdfPattern[]>(),
    ]);

    if (analysis.error || !analysis.data) {
      throw analysis.error ?? new Error("Analysis row not found");
    }
    // Patterns are decoration, not the document: a failed read renders an
    // empty Patterns section instead of losing the whole attachment.
    if (patterns.error) {
      logger.error("failed to load analysis patterns for PDF", {
        analysisId,
        cause: String(patterns.error),
      });
    }

    const image = await loadChartImage(analysis.data.image_key);
    const content = buildAnalysisPdf(analysis.data, patterns.data ?? [], image);

    return { filename: pdfFileNameFor(analysis.data), content };
  } catch (cause) {
    logger.error("failed to build analysis PDF attachment", {
      analysisId,
      cause: String(cause),
    });
    return null;
  }
}
