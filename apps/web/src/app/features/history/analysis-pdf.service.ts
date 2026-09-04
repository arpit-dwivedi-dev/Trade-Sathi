import { Injectable, inject } from '@angular/core';
// Type-only: the library itself is loaded on demand in download(). jsPDF drags
// canvg and core-js in behind it (~200KB raw), and this whole feature is
// reachable only by clicking Download PDF inside the History tab — a static
// import put all of it in the /app chunk that every signed-in user downloads.
import type { jsPDF } from 'jspdf';

import type { AnalysisResult, AnalysisScenario } from '@chartanalyzer/shared';

import { SupabaseClientService } from '../../core/supabase-client';
import type { AnalysisPattern, AnalysisRow } from '../analyze/analysis.types';

const BUCKET = 'chart-images';
/** Only needs to outlive the single fetch this service makes. */
const SIGNED_URL_TTL_SECONDS = 120;

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

interface LoadedImage {
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
  if (value === null) return '—';
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatPercent(value: number | null): string {
  if (value === null) return '—';
  return `${Math.round(value * 100)}%`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** A code like `price_mid_range` as the words a reader can act on. */
function humanise(code: string): string {
  return code.replace(/_/g, ' ');
}

/**
 * A level or trigger ZONE, which is what the prompts emit — never a point. A
 * band whose edges coincide prints as one number rather than "1402 – 1402".
 */
function formatBand(low: number, high: number): string {
  return low === high ? formatNumber(low) : `${formatNumber(low)} – ${formatNumber(high)}`;
}

/**
 * Filenames are user-visible and end up on a filesystem: strip anything that
 * is not safe there rather than trusting a model-detected symbol.
 */
function fileNameFor(row: AnalysisRow): string {
  const symbol = (row.symbol ?? row.symbol_raw ?? 'analysis')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const stamp = row.created_at.slice(0, 10);
  return `chartanalyzer-${symbol || 'analysis'}-${stamp}.pdf`;
}

/**
 * Renders one analysis (row + patterns + its chart) into a downloadable PDF.
 *
 * Built with jsPDF's text/image primitives rather than by rasterising the DOM:
 * the on-screen result is a responsive layout with signed-URL images, and a
 * screenshot of it would come out at whatever width the viewport happened to
 * be. Laying the page out directly also keeps the text selectable.
 */
@Injectable({ providedIn: 'root' })
export class AnalysisPdfService {
  private readonly supabase = inject(SupabaseClientService);

  async download(row: AnalysisRow, patterns: AnalysisPattern[]): Promise<void> {
    // Resolved once and then cached by the module loader, so a second export in
    // the same session pays nothing.
    const { jsPDF: JsPdf } = await import('jspdf');

    const doc = new JsPdf({ unit: 'mm', format: 'a4' });
    // The chart is the one part that can fail on its own (private bucket, an
    // expired object). A missing image must not cost the user the whole export.
    const image = await this.loadImage(row.image_key);

    let y = this.drawHeader(doc, row);
    y = this.drawChart(doc, image, y);

    // Two document shapes, for the same reason the on-screen report has two:
    // a row analyzed by the current prompts carries the whole structured read
    // in `analysis_result`, and one from before them carries the old flat
    // reading in its own columns. Both are the user's history, so both render.
    const result = row.analysis_result;
    if (result) {
      y = this.drawReadQuality(doc, result, y);
      y = this.drawSummary(doc, result.summary, y);
      y = this.drawSetup(doc, result, y);
      y = this.drawLevelZones(doc, result, y);
      y = this.drawStructure(doc, result, y);
      y = this.drawFalsifier(doc, result, y);
      y = this.drawBaseRate(doc, result, y);
    } else {
      y = this.drawLegacyReadings(doc, row, y);
      y = this.drawSummary(doc, row.summary, y);
      y = this.drawLegacyScenario(doc, row, y);
      y = this.drawLegacyLevels(doc, row, y);
      y = this.drawLegacyPatterns(doc, patterns, y);
    }

    this.drawDisclaimer(doc, row, y);

    doc.save(fileNameFor(row));
  }

  /** Moves to a new page when `needed` mm would not fit below `y`. */
  private space(doc: jsPDF, y: number, needed: number): number {
    if (y + needed <= PAGE_H - MARGIN) return y;
    doc.addPage();
    return MARGIN;
  }

  private sectionTitle(doc: jsPDF, title: string, y: number): number {
    let top = this.space(doc, y, 14);
    doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(INK);
    doc.text(title, MARGIN, top);
    top += 2;
    doc.setDrawColor(RULE).setLineWidth(0.2);
    doc.line(MARGIN, top, PAGE_W - MARGIN, top);
    return top + 6;
  }

  /** One `label   value` line, label dimmed on the left, value on the right. */
  private row(doc: jsPDF, label: string, value: string, y: number): number {
    const top = this.space(doc, y, 7);
    doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(DIM);
    doc.text(label, MARGIN, top);
    doc.setFont('helvetica', 'bold').setTextColor(INK);
    doc.text(value, PAGE_W - MARGIN, top, { align: 'right' });
    return top + 6;
  }

  private paragraph(doc: jsPDF, text: string, y: number): number {
    doc.setFont('helvetica', 'normal').setFontSize(9.5).setTextColor(INK);
    const lines = wrap(doc, text, CONTENT_W);
    let top = y;
    for (const line of lines) {
      top = this.space(doc, top, 6);
      doc.text(line, MARGIN, top);
      top += 5;
    }
    return top + 2;
  }

  private drawHeader(doc: jsPDF, row: AnalysisRow): number {
    doc.setFont('helvetica', 'bold').setFontSize(18).setTextColor(INK);
    doc.text(row.symbol ?? row.symbol_raw ?? 'Unknown symbol', MARGIN, MARGIN + 6);

    const chips = [
      row.analysis_result?.identity.instrument_type ?? row.asset_class,
      row.timeframe,
      row.source ?? row.source_type,
      row.status,
    ]
      .filter((chip): chip is string => Boolean(chip))
      .join('  ·  ');
    doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(DIM);
    doc.text(chips, MARGIN, MARGIN + 12);
    doc.text(`Analyzed ${formatDate(row.created_at)}`, PAGE_W - MARGIN, MARGIN + 6, {
      align: 'right',
    });
    doc.text('ChartAnalyzer', PAGE_W - MARGIN, MARGIN + 12, { align: 'right' });

    doc.setDrawColor(RULE).setLineWidth(0.3);
    doc.line(MARGIN, MARGIN + 16, PAGE_W - MARGIN, MARGIN + 16);
    return MARGIN + 26;
  }

  private drawChart(doc: jsPDF, image: LoadedImage | null, y: number): number {
    let top = this.sectionTitle(doc, 'Chart', y);
    if (!image) {
      doc.setFont('helvetica', 'italic').setFontSize(9).setTextColor(DIM);
      doc.text('The chart image could not be included.', MARGIN, top);
      return top + 8;
    }

    const scale = Math.min(CONTENT_W / image.width, MAX_IMAGE_H / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    top = this.space(doc, top, height + 4);
    doc.addImage(image.dataUrl, image.format, MARGIN, top, width, height);
    return top + height + 10;
  }

  /** Small dimmed italic prose — a caveat, not a reading. */
  private note(doc: jsPDF, text: string, y: number): number {
    doc.setFont('helvetica', 'italic').setFontSize(8).setTextColor(DIM);
    let top = this.space(doc, y, 8);
    for (const line of wrap(doc, text, CONTENT_W)) {
      doc.text(line, MARGIN, top);
      top += 4;
    }
    return top + 2;
  }

  private drawSummary(doc: jsPDF, summary: string | null, y: number): number {
    const top = this.sectionTitle(doc, 'Summary', y);
    return this.paragraph(doc, summary ?? 'No summary was produced.', top) + 4;
  }

  /* ── the structured read ─────────────────────────────────────────────── */

  /**
   * How trustworthy the read itself is, before anything it concluded.
   *
   * Silent on a clean calibrated chart with no blockers, which is the correct
   * amount of space to spend saying "nothing went wrong".
   */
  private drawReadQuality(doc: jsPDF, result: AnalysisResult, y: number): number {
    const caveats = [...result.meta.blockers.map(humanise), ...result.meta.notes];
    if (result.meta.corporate_action_suspected) {
      caveats.push('a price gap consistent with a split or bonus is present in this window');
    }
    const degraded = result.meta.axis_state !== 'calibrated';
    if (caveats.length === 0 && !degraded) return y;

    let top = this.sectionTitle(doc, 'How to read this', y);
    if (degraded) top = this.row(doc, 'Price axis', humanise(result.meta.axis_state), top);
    if (result.meta.price_read_error_pct !== null) {
      top = this.row(doc, 'Price-read error', `±${result.meta.price_read_error_pct}%`, top);
    }
    for (const caveat of caveats) top = this.paragraph(doc, `• ${caveat}`, top);
    return top + 2;
  }

  private drawStructure(doc: jsPDF, result: AnalysisResult, y: number): number {
    let top = this.sectionTitle(doc, 'Structure and regime', y);
    top = this.row(doc, 'Structure', result.structure.state ?? '—', top);
    top = this.row(doc, 'Clarity', result.structure.clarity, top);
    top = this.row(
      doc,
      'Position in range',
      result.structure.range_position !== null
        ? formatPercent(result.structure.range_position)
        : '—',
      top,
    );
    top = this.row(
      doc,
      'ATR',
      result.regime.atr_pct !== null ? `${result.regime.atr_pct}% of price` : '—',
      top,
    );
    if (result.regime.atr_percentile !== null) {
      top = this.row(
        doc,
        'ATR percentile (window)',
        formatPercent(result.regime.atr_percentile),
        top,
      );
    }
    top = this.row(
      doc,
      'Volume vs median',
      result.regime.volume_vs_median !== null ? `${result.regime.volume_vs_median}×` : '—',
      top,
    );
    top = this.row(doc, 'Follow-through', result.regime.persistence ?? '—', top);
    return top + 4;
  }

  private drawLevelZones(doc: jsPDF, result: AnalysisResult, y: number): number {
    let top = this.sectionTitle(doc, 'Level zones', y);
    if (result.structure.levels.length === 0) {
      doc.setFont('helvetica', 'normal').setFontSize(9.5).setTextColor(INK);
      top = this.space(doc, top, 8);
      doc.text('No zone was grounded in enough price action to report.', MARGIN, top);
      return top + 8;
    }

    for (const zone of result.structure.levels) {
      const reach = zone.dist_atr !== null ? `  ·  ${zone.dist_atr} ATR away` : '';
      top = this.row(
        doc,
        `${zone.kind === 'support' ? 'Support' : 'Resistance'}  ·  ${zone.touches} touches${reach}`,
        formatBand(zone.low, zone.high),
        top,
      );
    }
    return (
      this.note(
        doc,
        "Zones, not prices: orders cluster around a focal level rather than at it, and the model's own read of that level carries error. The width is the honest part.",
        top,
      ) + 2
    );
  }

  private drawOneScenario(
    doc: jsPDF,
    scenario: AnalysisScenario,
    index: number,
    y: number,
  ): number {
    const heading =
      scenario.trigger === 'already_triggered'
        ? `${scenario.direction.toUpperCase()} · already triggered`
        : `${scenario.direction.toUpperCase()} · on a ${humanise(scenario.trigger)}`;

    let top = this.space(doc, y, 10);
    doc.setFont('helvetica', 'bold').setFontSize(9.5).setTextColor(INK);
    doc.text(`${index + 1}. ${heading}`, MARGIN, top);
    top += 6;

    top = this.row(doc, 'Trigger', formatBand(scenario.trigger_low, scenario.trigger_high), top);
    top = this.row(doc, 'Invalidation', formatNumber(scenario.invalidation), top);
    top = this.row(
      doc,
      `Target (${humanise(scenario.target_basis)})`,
      formatNumber(scenario.target),
      top,
    );
    if (scenario.obstacle !== null) {
      top = this.row(doc, 'Untested obstacle en route', formatNumber(scenario.obstacle), top);
    }
    top = this.row(
      doc,
      'P(target before invalidation | trigger fires)',
      scenario.p_target_before_invalidation.toFixed(2),
      top,
    );
    top = this.row(doc, 'Horizon', `${scenario.horizon_candles} candles`, top);
    return top + 2;
  }

  private drawSetup(doc: jsPDF, result: AnalysisResult, y: number): number {
    let top = this.sectionTitle(doc, 'Setup', y);

    if (result.setup.format === 'none') {
      top = this.row(doc, 'Format', 'no setup', top);
      top = this.paragraph(
        doc,
        result.setup.abstain_reason
          ? `The chart supports no scenario: ${humanise(result.setup.abstain_reason)}.`
          : 'The chart supports no scenario.',
        top,
      );
      return (
        this.note(
          doc,
          'An abstention is a result, not a gap. The prompt is built to say nothing rather than invent a trade.',
          top,
        ) + 2
      );
    }

    top = this.row(doc, 'Format', humanise(result.setup.format), top);
    result.setup.scenarios.forEach((scenario, index) => {
      top = this.drawOneScenario(doc, scenario, index, top);
    });

    return (
      this.note(
        doc,
        'Each scenario is a geometry conditional on its trigger firing — not a prediction that price will get there, and not advice. The probability is conditional on the trigger and bounded by what evidence supports.',
        top,
      ) + 2
    );
  }

  private drawFalsifier(doc: jsPDF, result: AnalysisResult, y: number): number {
    const top = this.sectionTitle(doc, 'What would prove this wrong', y);
    return this.paragraph(doc, result.falsifier, top) + 4;
  }

  private drawBaseRate(doc: jsPDF, result: AnalysisResult, y: number): number {
    const { n_analogues, hit_rate, definition } = result.base_rate;
    // All three are null together, by contract: a hit rate off fewer than
    // twenty counted analogues is noise, and the API's schema drops it.
    if (n_analogues === null || hit_rate === null) return y;

    let top = this.sectionTitle(doc, 'Base rate', y);
    top = this.row(doc, 'Analogues counted', String(n_analogues), top);
    top = this.row(doc, 'Hit rate', formatPercent(hit_rate), top);
    if (definition) top = this.paragraph(doc, definition, top);
    return this.note(doc, 'Counted within this window only — not a historical study.', top) + 2;
  }

  /* ── rows analyzed before the structured-read prompts ────────────────── */

  private drawLegacyReadings(doc: jsPDF, row: AnalysisRow, y: number): number {
    let top = this.sectionTitle(doc, 'What the model observed', y);
    top = this.row(doc, 'Trend', row.trend ?? '—', top);
    top = this.row(doc, 'Volatility', row.volatility ?? '—', top);
    top = this.row(doc, 'Volume', row.volume_reading ?? '—', top);
    top = this.row(doc, 'Sentiment', row.sentiment ?? '—', top);
    return top + 4;
  }

  private drawLegacyScenario(doc: jsPDF, row: AnalysisRow, y: number): number {
    if (!row.call_direction) return y;

    let top = this.sectionTitle(doc, 'AI scenario', y);
    top = this.row(doc, 'Direction', row.call_direction.toUpperCase(), top);
    top = this.row(doc, 'Confidence', formatPercent(row.call_confidence), top);
    top = this.row(doc, 'Reference level', formatNumber(row.call_entry), top);
    top = this.row(doc, 'Invalidation', formatNumber(row.call_invalidation), top);
    top = this.row(doc, 'Target', formatNumber(row.call_target), top);
    top = this.row(
      doc,
      'Horizon',
      row.horizon_candles !== null ? `${row.horizon_candles} candles` : '—',
      top,
    );

    return (
      this.note(
        doc,
        'This is one scenario the model considered, with the levels it would be measured against. It is not advice.',
        top,
      ) + 2
    );
  }

  private drawLegacyLevels(doc: jsPDF, row: AnalysisRow, y: number): number {
    let top = this.sectionTitle(doc, 'Support & resistance', y);
    const resistances = row.resistance_levels ?? [];
    const supports = row.support_levels ?? [];

    top = this.row(
      doc,
      'Resistance',
      resistances.length ? resistances.map(formatNumber).join('   ') : 'None identified',
      top,
    );
    top = this.row(
      doc,
      'Support',
      supports.length ? supports.map(formatNumber).join('   ') : 'None identified',
      top,
    );
    return top + 4;
  }

  private drawLegacyPatterns(doc: jsPDF, patterns: AnalysisPattern[], y: number): number {
    let top = this.sectionTitle(doc, 'Patterns', y);
    if (!patterns.length) {
      doc.setFont('helvetica', 'normal').setFontSize(9.5).setTextColor(INK);
      doc.text('No patterns detected.', MARGIN, top);
      return top + 8;
    }

    for (const pattern of patterns) {
      top = this.row(doc, pattern.pattern_key, formatPercent(pattern.confidence), top);
      if (pattern.pattern_note) top = this.paragraph(doc, pattern.pattern_note, top);
    }
    return top + 4;
  }

  private drawDisclaimer(doc: jsPDF, row: AnalysisRow, y: number): void {
    const top = this.space(doc, y, 20) + 2;
    doc.setDrawColor(RULE).setLineWidth(0.2);
    doc.line(MARGIN, top - 4, PAGE_W - MARGIN, top - 4);
    doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(DIM);
    // A computed read measured the exact candles; a vision read looked at a
    // picture of them. Telling a user the wrong one describes a step that
    // never happened.
    const provenance =
      row.analysis_result?.kind === 'computed'
        ? 'Every reading and level in this document is generated by the model from the exact price data behind the chart above.'
        : 'Every reading and level in this document is generated by the model from the image alone.';
    const lines = wrap(
      doc,
      `${provenance} ChartAnalyzer does not connect to a broker, hold positions, or track what happens after an analysis.`,
      CONTENT_W,
    );
    doc.text(lines, MARGIN, top);
  }

  /**
   * Signs the private storage key, fetches the bytes and reads their intrinsic
   * size — jsPDF needs both the data and the aspect ratio to place the image.
   * Returns null rather than throwing: the rest of the PDF is still worth having.
   */
  private async loadImage(key: string | null): Promise<LoadedImage | null> {
    const client = this.supabase.client;
    if (!key || !client) return null;

    try {
      const { data, error } = await client.storage
        .from(BUCKET)
        .createSignedUrl(key, SIGNED_URL_TTL_SECONDS);
      if (error || !data) throw error ?? new Error('Signing returned no URL');

      const response = await fetch(data.signedUrl);
      if (!response.ok) throw new Error(`Chart image fetch failed: ${response.status}`);
      const blob = await response.blob();

      const bitmap = await createImageBitmap(blob);
      const { width, height } = bitmap;
      bitmap.close();

      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error ?? new Error('Could not read chart image'));
        reader.readAsDataURL(blob);
      });

      const subtype = blob.type.split('/')[1]?.toUpperCase() ?? 'PNG';
      const format = subtype === 'JPG' ? 'JPEG' : subtype;
      return { dataUrl, format, width, height };
    } catch (cause) {
      console.warn('chart image could not be embedded in the PDF', cause);
      return null;
    }
  }
}
