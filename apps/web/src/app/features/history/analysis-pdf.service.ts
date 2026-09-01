import { Injectable, inject } from '@angular/core';
// Type-only: the library itself is loaded on demand in download(). jsPDF drags
// canvg and core-js in behind it (~200KB raw), and this whole feature is
// reachable only by clicking Download PDF inside the History tab — a static
// import put all of it in the /app chunk that every signed-in user downloads.
import type { jsPDF } from 'jspdf';

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
    y = this.drawReadings(doc, row, y);
    y = this.drawSummary(doc, row, y);
    y = this.drawScenario(doc, row, y);
    y = this.drawLevels(doc, row, y);
    y = this.drawPatterns(doc, patterns, y);
    this.drawDisclaimer(doc, y);

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

    const chips = [row.asset_class, row.timeframe, row.source_type, row.status]
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

  private drawReadings(doc: jsPDF, row: AnalysisRow, y: number): number {
    let top = this.sectionTitle(doc, 'What the model observed', y);
    top = this.row(doc, 'Trend', row.trend ?? '—', top);
    top = this.row(doc, 'Volatility', row.volatility ?? '—', top);
    top = this.row(doc, 'Volume', row.volume_reading ?? '—', top);
    top = this.row(doc, 'Sentiment', row.sentiment ?? '—', top);
    return top + 4;
  }

  private drawSummary(doc: jsPDF, row: AnalysisRow, y: number): number {
    const top = this.sectionTitle(doc, 'Summary', y);
    return this.paragraph(doc, row.summary ?? 'No summary was produced.', top) + 4;
  }

  private drawScenario(doc: jsPDF, row: AnalysisRow, y: number): number {
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

    doc.setFont('helvetica', 'italic').setFontSize(8).setTextColor(DIM);
    top = this.space(doc, top, 8);
    const note = wrap(
      doc,
      'This is one scenario the model considered, with the levels it would be measured against. It is not advice.',
      CONTENT_W,
    );
    for (const line of note) {
      doc.text(line, MARGIN, top);
      top += 4;
    }
    return top + 4;
  }

  private drawLevels(doc: jsPDF, row: AnalysisRow, y: number): number {
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

  private drawPatterns(doc: jsPDF, patterns: AnalysisPattern[], y: number): number {
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

  private drawDisclaimer(doc: jsPDF, y: number): void {
    const top = this.space(doc, y, 16) + 2;
    doc.setDrawColor(RULE).setLineWidth(0.2);
    doc.line(MARGIN, top - 4, PAGE_W - MARGIN, top - 4);
    doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(DIM);
    const lines = wrap(
      doc,
      'Every reading and level in this document is generated by the model from the image alone. ChartAnalyzer does not connect to a broker, hold positions, or track what happens after an analysis.',
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
