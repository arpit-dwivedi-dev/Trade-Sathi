import { jsPDF } from "jspdf";
import { type AnalysisResult, type AnalysisScenario } from "@tradesathi/shared";

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
 *
 * TWO DOCUMENT SHAPES
 *
 * A row written by the current prompts carries `analysis_result` — the whole
 * structured read (see AnalysisResult in packages/shared). A row written before
 * that carries the old flat reading in its own columns and no payload. Both
 * still have to render: the old rows are the user's history, and a Download
 * button that produced a blank page for them would be worse than the branch.
 * `analysis_result` being non-null is the test for which.
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
  timeframe: string | null;
  source_type: string | null;
  source: string | null;
  status: string | null;
  summary: string | null;
  created_at: string;
  /** The structured read. Null for rows written before the current prompts. */
  analysis_result: AnalysisResult | null;
  /* --- legacy columns, rendered only when analysis_result is null --------- */
  asset_class: string | null;
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

/** A code like `price_mid_range` as the words a reader can act on. */
function humanise(code: string): string {
  return code.replace(/_/g, " ");
}

/**
 * A level or trigger ZONE, which is what the prompts emit — never a point. A
 * band whose edges coincide prints as one number rather than "1402 – 1402".
 */
function formatBand(low: number, high: number): string {
  return low === high ? formatNumber(low) : `${formatNumber(low)} – ${formatNumber(high)}`;
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
  return `tradesathi-${symbol || "analysis"}-${stamp}.pdf`;
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

/** Small dimmed italic prose — a caveat, not a reading. */
function note(doc: jsPDF, text: string, y: number): number {
  doc.setFont("helvetica", "italic").setFontSize(8).setTextColor(DIM);
  let top = space(doc, y, 8);
  for (const line of wrap(doc, text, CONTENT_W)) {
    doc.text(line, MARGIN, top);
    top += 4;
  }
  return top + 2;
}

function drawHeader(doc: jsPDF, row: AnalysisPdfRow): number {
  doc.setFont("helvetica", "bold").setFontSize(18).setTextColor(INK);
  doc.text(row.symbol ?? row.symbol_raw ?? "Unknown symbol", MARGIN, MARGIN + 6);

  const chips = [
    row.analysis_result?.identity.instrument_type ?? row.asset_class,
    row.timeframe,
    row.source ?? row.source_type,
    row.status,
  ]
    .filter((chip): chip is string => Boolean(chip))
    .join("  ·  ");
  doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(DIM);
  doc.text(chips, MARGIN, MARGIN + 12);
  doc.text(`Analyzed ${formatDate(row.created_at)}`, PAGE_W - MARGIN, MARGIN + 6, {
    align: "right",
  });
  doc.text("TradeSathi", PAGE_W - MARGIN, MARGIN + 12, { align: "right" });

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

function drawSummary(doc: jsPDF, summary: string | null, y: number): number {
  const top = sectionTitle(doc, "Summary", y);
  return paragraph(doc, summary ?? "No summary was produced.", top) + 4;
}

/* -------------------------------------------------------------------------- */
/* The structured read                                                         */
/* -------------------------------------------------------------------------- */

/**
 * How trustworthy the read itself is, before anything it concluded.
 *
 * Drawn only when there is something to say. On a clean calibrated chart with
 * no blockers this section is silent, which is the correct amount of space to
 * spend saying "nothing went wrong".
 */
function drawReadQuality(doc: jsPDF, result: AnalysisResult, y: number): number {
  const caveats: string[] = [
    ...result.meta.blockers.map(humanise),
    ...result.meta.notes,
  ];
  const degraded = result.meta.axis_state !== "calibrated";
  if (result.meta.corporate_action_suspected) {
    caveats.push("a price gap consistent with a split or bonus is present in this window");
  }
  if (caveats.length === 0 && !degraded) return y;

  let top = sectionTitle(doc, "How to read this", y);
  if (degraded) {
    top = labelledRow(doc, "Price axis", humanise(result.meta.axis_state), top);
  }
  if (result.meta.price_read_error_pct !== null) {
    top = labelledRow(doc, "Price-read error", `±${result.meta.price_read_error_pct}%`, top);
  }
  for (const caveat of caveats) {
    top = paragraph(doc, `• ${caveat}`, top);
  }
  return top + 2;
}

function drawStructure(doc: jsPDF, result: AnalysisResult, y: number): number {
  let top = sectionTitle(doc, "Structure and regime", y);
  top = labelledRow(doc, "Structure", result.structure.state ?? "—", top);
  top = labelledRow(doc, "Clarity", result.structure.clarity, top);
  top = labelledRow(
    doc,
    "Position in range",
    result.structure.range_position !== null
      ? formatPercent(result.structure.range_position)
      : "—",
    top,
  );
  top = labelledRow(
    doc,
    "ATR",
    result.regime.atr_pct !== null ? `${result.regime.atr_pct}% of price` : "—",
    top,
  );
  if (result.regime.atr_percentile !== null) {
    top = labelledRow(
      doc,
      "ATR percentile (window)",
      formatPercent(result.regime.atr_percentile),
      top,
    );
  }
  top = labelledRow(
    doc,
    "Volume vs median",
    result.regime.volume_vs_median !== null ? `${result.regime.volume_vs_median}×` : "—",
    top,
  );
  top = labelledRow(doc, "Follow-through", result.regime.persistence ?? "—", top);
  return top + 4;
}

function drawLevelZones(doc: jsPDF, result: AnalysisResult, y: number): number {
  let top = sectionTitle(doc, "Level zones", y);
  if (result.structure.levels.length === 0) {
    doc.setFont("helvetica", "normal").setFontSize(9.5).setTextColor(INK);
    top = space(doc, top, 8);
    doc.text("No zone was grounded in enough price action to report.", MARGIN, top);
    return top + 8;
  }

  for (const zone of result.structure.levels) {
    const reach = zone.dist_atr !== null ? `  ·  ${zone.dist_atr} ATR away` : "";
    top = labelledRow(
      doc,
      `${zone.kind === "support" ? "Support" : "Resistance"}  ·  ${zone.touches} touches${reach}`,
      formatBand(zone.low, zone.high),
      top,
    );
  }
  top = note(
    doc,
    "Zones, not prices: orders cluster around a focal level rather than at it, and the model's own read of that level carries error. The width is the honest part.",
    top,
  );
  return top + 2;
}

function drawScenario(doc: jsPDF, scenario: AnalysisScenario, index: number, y: number): number {
  const heading =
    scenario.trigger === "already_triggered"
      ? `${scenario.direction.toUpperCase()} · already triggered`
      : `${scenario.direction.toUpperCase()} · on a ${humanise(scenario.trigger)}`;

  let top = space(doc, y, 10);
  doc.setFont("helvetica", "bold").setFontSize(9.5).setTextColor(INK);
  doc.text(`${index + 1}. ${heading}`, MARGIN, top);
  top += 6;

  top = labelledRow(doc, "Trigger", formatBand(scenario.trigger_low, scenario.trigger_high), top);
  top = labelledRow(doc, "Invalidation", formatNumber(scenario.invalidation), top);
  top = labelledRow(
    doc,
    `Target (${humanise(scenario.target_basis)})`,
    formatNumber(scenario.target),
    top,
  );
  if (scenario.obstacle !== null) {
    top = labelledRow(doc, "Untested obstacle en route", formatNumber(scenario.obstacle), top);
  }
  top = labelledRow(
    doc,
    "P(target before invalidation | trigger fires)",
    scenario.p_target_before_invalidation.toFixed(2),
    top,
  );
  top = labelledRow(doc, "Horizon", `${scenario.horizon_candles} candles`, top);
  return top + 2;
}

function drawSetup(doc: jsPDF, result: AnalysisResult, y: number): number {
  let top = sectionTitle(doc, "Setup", y);

  if (result.setup.format === "none") {
    top = labelledRow(doc, "Format", "no setup", top);
    top = paragraph(
      doc,
      result.setup.abstain_reason
        ? `The chart supports no scenario: ${humanise(result.setup.abstain_reason)}.`
        : "The chart supports no scenario.",
      top,
    );
    return (
      note(
        doc,
        "An abstention is a result, not a gap. The prompt is built to say nothing rather than invent a trade.",
        top,
      ) + 2
    );
  }

  top = labelledRow(doc, "Format", humanise(result.setup.format), top);
  result.setup.scenarios.forEach((scenario, index) => {
    top = drawScenario(doc, scenario, index, top);
  });

  return (
    note(
      doc,
      "Each scenario is a geometry conditional on its trigger firing — not a prediction that price will get there, and not advice. The probability is conditional on the trigger and bounded by what evidence supports.",
      top,
    ) + 2
  );
}

function drawFalsifier(doc: jsPDF, result: AnalysisResult, y: number): number {
  const top = sectionTitle(doc, "What would prove this wrong", y);
  return paragraph(doc, result.falsifier, top) + 4;
}

function drawBaseRate(doc: jsPDF, result: AnalysisResult, y: number): number {
  const { n_analogues, hit_rate, definition } = result.base_rate;
  // All three are null together, by contract: a hit rate off fewer than
  // twenty counted analogues is noise, and the schema drops it.
  if (n_analogues === null || hit_rate === null) return y;

  let top = sectionTitle(doc, "Base rate", y);
  top = labelledRow(doc, "Analogues counted", String(n_analogues), top);
  top = labelledRow(doc, "Hit rate", formatPercent(hit_rate), top);
  if (definition) top = paragraph(doc, definition, top);
  return (
    note(doc, "Counted within this window only — not a historical study.", top) + 2
  );
}

/* -------------------------------------------------------------------------- */
/* Legacy rows                                                                 */
/* -------------------------------------------------------------------------- */

function drawLegacyReadings(doc: jsPDF, row: AnalysisPdfRow, y: number): number {
  let top = sectionTitle(doc, "What the model observed", y);
  top = labelledRow(doc, "Trend", row.trend ?? "—", top);
  top = labelledRow(doc, "Volatility", row.volatility ?? "—", top);
  top = labelledRow(doc, "Volume", row.volume_reading ?? "—", top);
  top = labelledRow(doc, "Sentiment", row.sentiment ?? "—", top);
  return top + 4;
}

function drawLegacyScenario(doc: jsPDF, row: AnalysisPdfRow, y: number): number {
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

  return (
    note(
      doc,
      "This is one scenario the model considered, with the levels it would be measured against. It is not advice.",
      top,
    ) + 2
  );
}

function drawLegacyLevels(doc: jsPDF, row: AnalysisPdfRow, y: number): number {
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

function drawLegacyPatterns(doc: jsPDF, patterns: AnalysisPdfPattern[], y: number): number {
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

function drawDisclaimer(doc: jsPDF, row: AnalysisPdfRow, y: number): void {
  const top = space(doc, y, 20) + 2;
  doc.setDrawColor(RULE).setLineWidth(0.2);
  doc.line(MARGIN, top - 4, PAGE_W - MARGIN, top - 4);
  doc.setFont("helvetica", "normal").setFontSize(8).setTextColor(DIM);
  // A computed read measured the exact candles; a vision read looked at a
  // picture of them. Telling a user the wrong one describes a step that never
  // happened.
  const provenance =
    row.analysis_result?.kind === "computed"
      ? "Every reading and level in this document is generated by the model from the exact price data behind the chart above."
      : "Every reading and level in this document is generated by the model from the image alone.";
  const lines = wrap(
    doc,
    `${provenance} TradeSathi does not connect to a broker, hold positions, or track what happens after an analysis.`,
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

  const result = row.analysis_result;
  if (result) {
    y = drawReadQuality(doc, result, y);
    y = drawSummary(doc, result.summary, y);
    y = drawSetup(doc, result, y);
    y = drawLevelZones(doc, result, y);
    y = drawStructure(doc, result, y);
    y = drawFalsifier(doc, result, y);
    y = drawBaseRate(doc, result, y);
  } else {
    // Written before the structured-read prompts; these columns are all it has.
    y = drawLegacyReadings(doc, row, y);
    y = drawSummary(doc, row.summary, y);
    y = drawLegacyScenario(doc, row, y);
    y = drawLegacyLevels(doc, row, y);
    y = drawLegacyPatterns(doc, patterns, y);
  }

  drawDisclaimer(doc, row, y);

  return Buffer.from(doc.output("arraybuffer"));
}
