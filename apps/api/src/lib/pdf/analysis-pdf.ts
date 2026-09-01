import { jsPDF } from "jspdf";

/**
 * Renders one stored analysis into a PDF, for attaching to a briefing email.
 *
 * A deliberate port of apps/web's AnalysisPdfService rather than a new layout:
 * the PDF a user gets emailed and the one they get from History's Download
 * button are the same document, and two layouts drifting apart would be worse
 * than the duplication. The two cannot share one module today — packages/shared
 * is types-only by convention, and the web copy is an Angular service that
 * loads jsPDF lazily and reads images through a browser signed-URL fetch.
 * Consolidate the moment a third caller appears.
 *
 * Pure: takes the row, its patterns and (optionally) already-loaded image bytes,
 * and returns PDF bytes. All I/O lives in analysis-pdf.service.ts.
 */

/** A4 portrait, in mm — jsPDF's default unit here. */
const PAGE_W = 210;
const PAGE_H = 297;
const MARGIN = 16;
const CONTENT_W = PAGE_W - MARGIN * 2;

const INK = 20;
const DIM = 120;
const RULE = 200;

/** What a chart image is allowed to take up before it is scaled down. */
const MAX_IMAGE_H = 110;

/** The columns of `analyses` this document renders. */
export interface AnalysisPdfRow {
  symbol: string | null;
  symbol_raw: string | null;
  asset_class: string | null;
  timeframe: string | null;
  source_type: string | null;
  status: string | null;
  trend: string | null;
  volatility: string | null;
  volume_reading: string | null;
  sentiment: string | null;
  support_levels: number[] | null;
  resistance_levels: number[] | null;
  call_direction: string | null;
  call_confidence: number | null;
  call_entry: number | null;
  call_invalidation: number | null;
  call_target: number | null;
  horizon_candles: number | null;
  summary: string | null;
  created_at: string;
}

export interface AnalysisPdfPattern {
  pattern_key: string;
  confidence: number | null;
  pattern_note: string | null;
}

/** A chart image already fetched and measured, ready to place. */
export interface AnalysisPdfImage {
  dataUrl: string;
  /** 'PNG' | 'JPEG' | 'WEBP' — jsPDF needs the format named explicitly. */
  format: string;
  width: number;
  height: number;
}

/**
 * jsPDF types `splitTextToSize` as returning `any`; it returns string[]. The
 * cast is contained here rather than repeated at each call site.
 */
function wrap(doc: jsPDF, text: string, width: number): string[] {
  const lines: unknown = doc.splitTextToSize(text, width);
  return Array.isArray(lines) ? (lines as string[]) : [String(lines)];
}

function formatNumber(value: number | null): string {
  if (value === null) return "—";
  return value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatPercent(value: number | null): string {
  if (value === null) return "—";
  return `${Math.round(value * 100)}%`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toISOString().replace("T", " ").slice(0, 16);
}

/**
 * Attachment filenames are user-visible and land on a filesystem: strip
 * anything unsafe there rather than trusting a model-detected symbol.
 */
export function pdfFileNameFor(row: AnalysisPdfRow): string {
  const symbol = (row.symbol ?? row.symbol_raw ?? "analysis")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const stamp = row.created_at.slice(0, 10);
  return `chartanalyzer-${symbol || "analysis"}-${stamp}.pdf`;
}

/** Moves to a new page when `needed` mm would not fit below `y`. */
function space(doc: jsPDF, y: number, needed: number): number {
  if (y + needed <= PAGE_H - MARGIN) return y;
  doc.addPage();
  return MARGIN;
}

function sectionTitle(doc: jsPDF, title: string, y: number): number {
  let top = space(doc, y, 14);
  doc.setFont("helvetica", "bold").setFontSize(11).setTextColor(INK);
  doc.text(title, MARGIN, top);
  top += 2;
  doc.setDrawColor(RULE).setLineWidth(0.2);
  doc.line(MARGIN, top, PAGE_W - MARGIN, top);
  return top + 6;
}

/** One `label   value` line, label dimmed on the left, value on the right. */
function labelledRow(doc: jsPDF, label: string, value: string, y: number): number {
  const top = space(doc, y, 7);
  doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(DIM);
  doc.text(label, MARGIN, top);
  doc.setFont("helvetica", "bold").setTextColor(INK);
  doc.text(value, PAGE_W - MARGIN, top, { align: "right" });
  return top + 6;
}

function paragraph(doc: jsPDF, text: string, y: number): number {
  doc.setFont("helvetica", "normal").setFontSize(9.5).setTextColor(INK);
  const lines = wrap(doc, text, CONTENT_W);
  let top = y;
  for (const line of lines) {
    top = space(doc, top, 6);
    doc.text(line, MARGIN, top);
    top += 5;
  }
  return top + 2;
}

function drawHeader(doc: jsPDF, row: AnalysisPdfRow): number {
  doc.setFont("helvetica", "bold").setFontSize(18).setTextColor(INK);
  doc.text(row.symbol ?? row.symbol_raw ?? "Unknown symbol", MARGIN, MARGIN + 6);

  const chips = [row.asset_class, row.timeframe, row.source_type, row.status]
    .filter((chip): chip is string => Boolean(chip))
    .join("  ·  ");
  doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(DIM);
  doc.text(chips, MARGIN, MARGIN + 12);
  doc.text(`Analyzed ${formatDate(row.created_at)}`, PAGE_W - MARGIN, MARGIN + 6, {
    align: "right",
  });
  doc.text("ChartAnalyzer", PAGE_W - MARGIN, MARGIN + 12, { align: "right" });

  doc.setDrawColor(RULE).setLineWidth(0.3);
  doc.line(MARGIN, MARGIN + 16, PAGE_W - MARGIN, MARGIN + 16);
  return MARGIN + 26;
}

function drawChart(doc: jsPDF, image: AnalysisPdfImage | null, y: number): number {
  let top = sectionTitle(doc, "Chart", y);
  if (!image) {
    doc.setFont("helvetica", "italic").setFontSize(9).setTextColor(DIM);
    doc.text("The chart image could not be included.", MARGIN, top);
    return top + 8;
  }

  const scale = Math.min(CONTENT_W / image.width, MAX_IMAGE_H / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  top = space(doc, top, height + 4);
  // The compression argument is not optional in practice. jsPDF embeds a PNG
  // by decoding it to raw RGB and storing that uncompressed, so a 1200x700
  // chart lands as ~2.4MB of pixels — one attachment already awkward, and a
  // thirty-symbol briefing well past what a mail provider will accept. Deflate
  // is lossless and takes the same page to ~11KB, because these charts are
  // flat-colour vector art rather than photographs.
  doc.addImage(image.dataUrl, image.format, MARGIN, top, width, height, undefined, "SLOW");
  return top + height + 10;
}

function drawReadings(doc: jsPDF, row: AnalysisPdfRow, y: number): number {
  let top = sectionTitle(doc, "What the model observed", y);
  top = labelledRow(doc, "Trend", row.trend ?? "—", top);
  top = labelledRow(doc, "Volatility", row.volatility ?? "—", top);
  top = labelledRow(doc, "Volume", row.volume_reading ?? "—", top);
  top = labelledRow(doc, "Sentiment", row.sentiment ?? "—", top);
  return top + 4;
}

function drawSummary(doc: jsPDF, row: AnalysisPdfRow, y: number): number {
  const top = sectionTitle(doc, "Summary", y);
  return paragraph(doc, row.summary ?? "No summary was produced.", top) + 4;
}

function drawScenario(doc: jsPDF, row: AnalysisPdfRow, y: number): number {
  if (!row.call_direction) return y;

  let top = sectionTitle(doc, "AI scenario", y);
  top = labelledRow(doc, "Direction", row.call_direction.toUpperCase(), top);
  top = labelledRow(doc, "Confidence", formatPercent(row.call_confidence), top);
  top = labelledRow(doc, "Reference level", formatNumber(row.call_entry), top);
  top = labelledRow(doc, "Invalidation", formatNumber(row.call_invalidation), top);
  top = labelledRow(doc, "Target", formatNumber(row.call_target), top);
  top = labelledRow(
    doc,
    "Horizon",
    row.horizon_candles !== null ? `${row.horizon_candles} candles` : "—",
    top,
  );

  doc.setFont("helvetica", "italic").setFontSize(8).setTextColor(DIM);
  top = space(doc, top, 8);
  const note = wrap(
    doc,
    "This is one scenario the model considered, with the levels it would be measured against. It is not advice.",
    CONTENT_W,
  );
  for (const line of note) {
    doc.text(line, MARGIN, top);
    top += 4;
  }
  return top + 4;
}

function drawLevels(doc: jsPDF, row: AnalysisPdfRow, y: number): number {
  let top = sectionTitle(doc, "Support & resistance", y);
  const resistances = row.resistance_levels ?? [];
  const supports = row.support_levels ?? [];

  top = labelledRow(
    doc,
    "Resistance",
    resistances.length ? resistances.map(formatNumber).join("   ") : "None identified",
    top,
  );
  top = labelledRow(
    doc,
    "Support",
    supports.length ? supports.map(formatNumber).join("   ") : "None identified",
    top,
  );
  return top + 4;
}

function drawPatterns(doc: jsPDF, patterns: AnalysisPdfPattern[], y: number): number {
  let top = sectionTitle(doc, "Patterns", y);
  if (!patterns.length) {
    doc.setFont("helvetica", "normal").setFontSize(9.5).setTextColor(INK);
    doc.text("No patterns detected.", MARGIN, top);
    return top + 8;
  }

  for (const pattern of patterns) {
    top = labelledRow(doc, pattern.pattern_key, formatPercent(pattern.confidence), top);
    if (pattern.pattern_note) top = paragraph(doc, pattern.pattern_note, top);
  }
  return top + 4;
}

function drawDisclaimer(doc: jsPDF, y: number): void {
  const top = space(doc, y, 16) + 2;
  doc.setDrawColor(RULE).setLineWidth(0.2);
  doc.line(MARGIN, top - 4, PAGE_W - MARGIN, top - 4);
  doc.setFont("helvetica", "normal").setFontSize(8).setTextColor(DIM);
  const lines = wrap(
    doc,
    "Every reading and level in this document is generated by the model from the image alone. ChartAnalyzer does not connect to a broker, hold positions, or track what happens after an analysis.",
    CONTENT_W,
  );
  doc.text(lines, MARGIN, top);
}

/** Lays out the whole document and returns its bytes. */
export function buildAnalysisPdf(
  row: AnalysisPdfRow,
  patterns: AnalysisPdfPattern[],
  image: AnalysisPdfImage | null,
): Buffer {
  const doc = new jsPDF({ unit: "mm", format: "a4" });

  let y = drawHeader(doc, row);
  y = drawChart(doc, image, y);
  y = drawReadings(doc, row, y);
  y = drawSummary(doc, row, y);
  y = drawScenario(doc, row, y);
  y = drawLevels(doc, row, y);
  y = drawPatterns(doc, patterns, y);
  drawDisclaimer(doc, y);

  return Buffer.from(doc.output("arraybuffer"));
}
