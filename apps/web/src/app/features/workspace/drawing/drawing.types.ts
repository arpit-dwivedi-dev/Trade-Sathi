/**
 * The workspace's drawing tools are KLineChart's own overlays, named exactly
 * as the library names them — so a tool, a persisted drawing's `kind` and the
 * overlay the chart creates are all one string with no mapping table between
 * them.
 *
 * The list is every overlay the library ships that means something on a price
 * chart. Nothing here is hand-drawn any more: the hit testing, dragging,
 * anchor handles and Fibonacci maths all come from KLineChart.
 */
export const DRAWING_KINDS = [
  'segment',
  'straightLine',
  'rayLine',
  'horizontalStraightLine',
  'horizontalRayLine',
  'horizontalSegment',
  'verticalStraightLine',
  'verticalRayLine',
  'verticalSegment',
  'priceLine',
  'parallelStraightLine',
  'priceChannelLine',
  'fibonacciLine',
  'brush',
  'simpleAnnotation',
  'simpleTag',
] as const;

export type DrawingKind = (typeof DRAWING_KINDS)[number];

/** 'cursor' selects and drags what is already drawn; every other value places a new drawing. */
export type DrawTool = 'cursor' | DrawingKind;

const KIND_SET = new Set<string>(DRAWING_KINDS);

export function isDrawingKind(value: unknown): value is DrawingKind {
  return typeof value === 'string' && KIND_SET.has(value);
}

export const DRAWING_LABELS: Record<DrawingKind, string> = {
  segment: 'Trend line',
  straightLine: 'Extended line',
  rayLine: 'Ray',
  horizontalStraightLine: 'Horizontal line',
  horizontalRayLine: 'Horizontal ray',
  horizontalSegment: 'Horizontal segment',
  verticalStraightLine: 'Vertical line',
  verticalRayLine: 'Vertical ray',
  verticalSegment: 'Vertical segment',
  priceLine: 'Price line',
  parallelStraightLine: 'Parallel channel',
  priceChannelLine: 'Price channel',
  fibonacciLine: 'Fibonacci retracement',
  brush: 'Freehand',
  simpleAnnotation: 'Arrow marker',
  simpleTag: 'Price tag',
};

/**
 * One Material Symbols ligature per tool, so the flyout that lists them reads
 * as a row of shapes rather than a column of prose — each glyph was picked to
 * echo what the tool actually draws (a slope, a horizontal rule, an arrow in
 * the direction the line runs).
 */
export const DRAWING_ICONS: Record<DrawingKind, string> = {
  segment: 'trending_up',
  straightLine: 'linear_scale',
  rayLine: 'north_east',
  horizontalStraightLine: 'horizontal_rule',
  horizontalRayLine: 'arrow_right_alt',
  horizontalSegment: 'remove',
  verticalStraightLine: 'height',
  verticalRayLine: 'arrow_upward',
  verticalSegment: 'straighten',
  priceLine: 'price_change',
  parallelStraightLine: 'format_line_spacing',
  priceChannelLine: 'stacked_line_chart',
  fibonacciLine: 'format_align_justify',
  brush: 'gesture',
  simpleAnnotation: 'push_pin',
  simpleTag: 'sell',
};

/**
 * How the rail groups the tools. Sixteen buttons down a 52px column would be
 * unusable, so the rail shows one button per group and the group opens a menu
 * — the same shape a charting app's toolbar normally takes.
 */
export interface ToolGroup {
  id: string;
  label: string;
  /** Material Symbols ligature for the rail button. */
  icon: string;
  tools: readonly DrawingKind[];
}

export const TOOL_GROUPS: readonly ToolGroup[] = [
  {
    id: 'lines',
    label: 'Lines',
    icon: 'show_chart',
    tools: [
      'segment',
      'straightLine',
      'rayLine',
      'horizontalStraightLine',
      'horizontalRayLine',
      'horizontalSegment',
      'verticalStraightLine',
      'verticalRayLine',
      'verticalSegment',
      'priceLine',
    ],
  },
  {
    id: 'channels',
    label: 'Channels',
    icon: 'density_medium',
    tools: ['parallelStraightLine', 'priceChannelLine'],
  },
  { id: 'fibonacci', label: 'Fibonacci', icon: 'format_align_justify', tools: ['fibonacciLine'] },
  {
    id: 'notes',
    label: 'Freehand & markers',
    icon: 'draw',
    tools: ['brush', 'simpleAnnotation', 'simpleTag'],
  },
];

/**
 * One anchor of a drawing, in KLineChart's own point space: a millisecond
 * timestamp and a price. The library round-trips exactly this shape through
 * an overlay's `points`, so a drawing can be persisted and restored without
 * the app converting between coordinate systems.
 */
export interface AnchorPoint {
  timestamp: number;
  value: number;
}

export interface Drawing {
  id: string;
  kind: DrawingKind;
  /** One anchor for a level, two for a line, three for a channel, many for freehand. */
  points: AnchorPoint[];
}

export function newDrawingId(): string {
  return `dr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
