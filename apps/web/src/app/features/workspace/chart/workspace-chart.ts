import { isPlatformBrowser } from '@angular/common';
import {
  Component,
  ElementRef,
  OnDestroy,
  PLATFORM_ID,
  effect,
  inject,
  input,
  output,
  untracked,
  viewChild,
} from '@angular/core';
import type { IndicatorCreate, Overlay, Point } from 'klinecharts';

import { ThemeService } from '../../../core/theme.service';
import {
  applyCandles,
  applyPalette,
  createCandleChart,
  disposeCandleChart,
  drawLevelOverlays,
  readPalette,
  updateLastCandle,
  type CandleChart,
  type ChartOverlays,
  type ChartPalette,
  type LiveCandle,
} from '../../../shared/live-chart/chart-render';
import {
  newDrawingId,
  type AnchorPoint,
  type Drawing,
  type DrawingKind,
  type DrawTool,
} from '../drawing/drawing.types';
import { INDICATOR_KINDS, indicatorPane, type IndicatorKind } from '../indicators/indicator-menu';

const REF_LINE_COLOR = 'rgba(148, 163, 184, 0.6)';
/** RSI's overbought/oversold guides — drawn as locked overlays on its own pane. */
const RSI_REF_LEVELS = [70, 30];
const SUB_PANE_HEIGHT = 100;

function indicatorId(kind: IndicatorKind): string {
  return `ws_ind_${kind}`;
}

function indicatorPaneId(kind: IndicatorKind): string {
  return indicatorPane(kind) === 'overlay' ? 'candle_pane' : `ws_pane_${kind}`;
}

function rsiRefId(level: number): string {
  return `ws_rsi_ref_${level}`;
}

/**
 * The Chart Analysis workspace's chart: reuses the same base candle+volume
 * renderer as the read-only `LiveChart` (`shared/live-chart/chart-render`) so
 * the two look identical, then layers on what the workspace adds —
 * indicators and the drawing tools.
 *
 * Both of those are now the chart library's own: KLineChart ships the
 * indicator maths, the overlay hit testing, dragging and magnet snapping that
 * this component used to drive by hand. What is left here is the mapping in
 * both directions — the app's tools and indicator menu onto the library's
 * names, and the anchors the library reports back onto the app's persisted
 * drawings.
 */
@Component({
  selector: 'app-workspace-chart',
  templateUrl: './workspace-chart.html',
  styleUrl: './workspace-chart.css',
})
export class WorkspaceChart implements OnDestroy {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly themeService = inject(ThemeService);

  readonly candles = input<LiveCandle[]>([]);
  readonly overlays = input<ChartOverlays | null>(null);
  readonly activeIndicators = input<ReadonlySet<IndicatorKind>>(new Set());
  readonly tool = input<DrawTool>('cursor');
  readonly drawings = input<Drawing[]>([]);

  /** Emitted whenever a drawing is placed, dragged, or (by the host, on delete) removed — the host persists it. */
  readonly drawingsChange = output<Drawing[]>();
  /** Emitted once a placement finishes or is cancelled — the host flips the active tool back to 'cursor'. */
  readonly toolConsumed = output<void>();
  readonly selectedDrawingId = output<string | null>();

  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('container');

  private chartReady: Promise<CandleChart> | null = null;
  private target: CandleChart | null = null;
  private destroyed = false;
  private appliedSignature: string | null = null;

  /** Overlay ids this component has on the chart, mirroring the `drawings` input. */
  private readonly overlayIds = new Set<string>();
  /** The overlay being placed right now — on the chart, not yet a drawing. */
  private pendingOverlayId: string | null = null;
  /**
   * Ids currently being removed by this component. KLineChart fires onRemoved
   * for every removal including our own, and without this the sync that
   * removed an overlay would be told to remove it again.
   */
  private readonly removing = new Set<string>();
  private readonly activeIndicatorKinds = new Set<IndicatorKind>();

  constructor() {
    // Candles and theme are separate effects on purpose — see LiveChart, whose
    // pattern this mirrors: a theme toggle must not reset pan/zoom, and new
    // candles must not repaint colours.
    effect(() => {
      const candles = this.candles();
      if (!this.isBrowser) return;
      this.withChart((target) => {
        const signature = seriesSignature(candles);
        const last = candles[candles.length - 1];
        if (last && signature === this.appliedSignature) {
          updateLastCandle(target, last);
          return;
        }
        applyCandles(target, candles);
        this.appliedSignature = signature;
      });
    });

    effect(() => {
      const overlays = this.overlays();
      if (!this.isBrowser) return;
      this.withChart((target) => drawLevelOverlays(target, overlays, this.palette()));
    });

    effect(() => {
      const theme = this.themeService.theme();
      if (!this.isBrowser) return;
      void theme;
      this.withChart((target) => applyPalette(target, this.palette()));
    });

    effect(() => {
      const active = this.activeIndicators();
      if (!this.isBrowser) return;
      this.withChart((target) => this.syncIndicators(target, active));
    });

    effect(() => {
      const tool = this.tool();
      if (!this.isBrowser) return;
      this.withChart((target) => this.applyTool(target, tool));
    });

    effect(() => {
      const drawings = this.drawings();
      if (!this.isBrowser) return;
      this.withChart((target) => this.syncDrawings(target, drawings));
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.target) disposeCandleChart(this.target);
    this.target = null;
    this.overlayIds.clear();
    this.activeIndicatorKinds.clear();
  }

  private palette(): ChartPalette {
    return readPalette(this.host().nativeElement);
  }

  /** See LiveChart.withChart — the chart library loads lazily, so every effect queues onto its construction. */
  private withChart(fn: (target: CandleChart) => void): void {
    this.chartReady ??= this.createChart();
    void this.chartReady.then(
      (target) => {
        if (!this.destroyed) fn(target);
      },
      (cause: unknown) => {
        console.warn('workspace chart could not be created', cause);
      },
    );
  }

  private async createChart(): Promise<CandleChart> {
    const element = this.host().nativeElement;
    const candles = untracked(this.candles);
    const target = await createCandleChart(element, this.palette(), candles);

    if (this.destroyed) {
      disposeCandleChart(target);
      throw new Error('workspace chart destroyed before it finished loading');
    }

    this.target = target;
    this.appliedSignature = seriesSignature(candles);
    return target;
  }

  // ---- indicators ----

  private syncIndicators(target: CandleChart, active: ReadonlySet<IndicatorKind>): void {
    for (const kind of INDICATOR_KINDS) {
      const wants = active.has(kind);
      const has = this.activeIndicatorKinds.has(kind);
      if (wants === has) continue;

      if (wants) {
        this.createIndicator(target, kind);
        this.activeIndicatorKinds.add(kind);
      } else {
        this.removeIndicator(target, kind);
        this.activeIndicatorKinds.delete(kind);
      }
    }
  }

  private createIndicator(target: CandleChart, kind: IndicatorKind): void {
    const paneId = indicatorPaneId(kind);

    // No calcParams: the library's defaults are the conventional periods, and
    // each indicator prints the ones it used in its own on-chart legend.
    // Always stacked, because the candle pane already holds the volume
    // indicator and an unstacked create would replace it.
    target.chart.createIndicator({ id: indicatorId(kind), name: kind, paneId } satisfies IndicatorCreate, true);

    if (indicatorPane(kind) === 'sub') {
      target.chart.setPaneOptions({ id: paneId, height: SUB_PANE_HEIGHT });
    }

    if (kind === 'RSI') {
      for (const level of RSI_REF_LEVELS) {
        target.chart.createOverlay({
          id: rsiRefId(level),
          name: 'horizontalStraightLine',
          paneId,
          points: [{ value: level }],
          lock: true,
          styles: { line: { color: REF_LINE_COLOR, size: 1, style: 'dashed' } },
        });
      }
    }
  }

  private removeIndicator(target: CandleChart, kind: IndicatorKind): void {
    if (kind === 'RSI') {
      for (const level of RSI_REF_LEVELS) target.chart.removeOverlay({ id: rsiRefId(level) });
    }
    // Removing the last indicator on a pane removes the pane too, so the
    // sub-pane layout needs no separate teardown.
    target.chart.removeIndicator({ id: indicatorId(kind) });
  }

  // ---- drawing tools ----

  /**
   * Starts a placement, or abandons one the user walked away from by picking
   * a different tool. KLineChart drives the placement itself once the overlay
   * exists with no points — the clicks, the preview and the anchor snapping
   * are all its own.
   */
  private applyTool(target: CandleChart, tool: DrawTool): void {
    if (this.pendingOverlayId !== null) {
      this.removeOverlay(target, this.pendingOverlayId);
      this.pendingOverlayId = null;
    }
    if (tool === 'cursor') return;

    const id = newDrawingId();
    this.pendingOverlayId = id;
    target.chart.createOverlay({
      id,
      // The tool *is* the library's overlay name — see drawing.types.ts.
      name: tool,
      ...this.overlayEvents(tool),
    });
  }

  private syncDrawings(target: CandleChart, drawings: Drawing[]): void {
    const wanted = new Set(drawings.map((drawing) => drawing.id));

    for (const id of [...this.overlayIds]) {
      if (wanted.has(id)) continue;
      this.removeOverlay(target, id);
    }

    for (const drawing of drawings) {
      if (this.overlayIds.has(drawing.id)) continue;
      target.chart.createOverlay({
        id: drawing.id,
        name: drawing.kind,
        points: drawing.points,
        ...this.overlayEvents(drawing.kind),
      });
      this.overlayIds.add(drawing.id);
    }
  }

  private removeOverlay(target: CandleChart, id: string): void {
    this.removing.add(id);
    target.chart.removeOverlay({ id });
    this.removing.delete(id);
    this.overlayIds.delete(id);
  }

  private overlayEvents(kind: DrawingKind) {
    return {
      onDrawEnd: ({ overlay }: { overlay: Overlay }): void => {
        this.pendingOverlayId = null;
        const points = toAnchors(overlay.points);
        if (points.length === 0) {
          // An anchor the chart could not resolve to a time and a price —
          // nothing worth persisting, and leaving it on screen would make a
          // drawing the side panel does not list.
          this.withChart((target) => this.removeOverlay(target, overlay.id));
          this.toolConsumed.emit();
          return;
        }
        this.overlayIds.add(overlay.id);
        this.emitDrawings({ id: overlay.id, kind, points });
        this.toolConsumed.emit();
      },
      onPressedMoveEnd: ({ overlay }: { overlay: Overlay }): void => {
        const points = toAnchors(overlay.points);
        if (points.length === 0) return;
        this.emitDrawings({ id: overlay.id, kind, points });
      },
      onSelected: ({ overlay }: { overlay: Overlay }): void => {
        this.selectedDrawingId.emit(overlay.id);
      },
      onDeselected: (): void => {
        this.selectedDrawingId.emit(null);
      },
      onRemoved: ({ overlay }: { overlay: Overlay }): void => {
        // Only a removal this component did not ask for — the library's own
        // delete affordances — has to be reflected back into the drawings.
        if (this.removing.has(overlay.id)) return;
        this.overlayIds.delete(overlay.id);
        this.drawingsChange.emit(this.drawings().filter((drawing) => drawing.id !== overlay.id));
      },
    };
  }

  /** Replaces `drawing` in the current list, or appends it if it is new. */
  private emitDrawings(drawing: Drawing): void {
    const current = this.drawings();
    const known = current.some((existing) => existing.id === drawing.id);
    const next = known
      ? current.map((existing) => (existing.id === drawing.id ? drawing : existing))
      : [...current, drawing];
    this.drawingsChange.emit(next);
  }
}

/**
 * Converts an overlay's anchors into the persisted shape, or returns an empty
 * list if any of them is incomplete — a point the chart could not place in
 * both time and price would restore in the wrong spot, so a partial drawing
 * is not persisted at all.
 */
function toAnchors(points: Array<Partial<Point>>): AnchorPoint[] {
  const anchors: AnchorPoint[] = [];
  for (const point of points) {
    if (typeof point.timestamp !== 'number' || typeof point.value !== 'number') return [];
    anchors.push({ timestamp: point.timestamp, value: point.value });
  }
  return anchors;
}

/**
 * A cheap identity for a drawn series. Deliberately ignores prices — see the
 * identical helper on LiveChart, which this mirrors.
 */
function seriesSignature(candles: LiveCandle[]): string {
  if (candles.length === 0) return '0';
  return `${candles.length}|${candles[0].timestamp}|${candles[candles.length - 1].timestamp}`;
}
