/**
 * The canonical shape of one AI analysis result.
 *
 * Both prompts in apps/api/src/prompts (the vision prompt that reads a
 * screenshot, and the candle prompt that reads exact OHLCV rows) describe
 * almost the same json object, differing only where the two inputs genuinely
 * differ — a screenshot has an axis that may be unreadable and a pixel-read
 * error, a candle series has exact closes and a suspected-corporate-action
 * check. `AnalysisResult` is the union of those two, normalised:
 *
 *  - every `"unknown"` the prompts allow becomes `null` here, so a consumer
 *    branches on one absent value rather than on a string that is sometimes a
 *    number,
 *  - the two spellings of the ATR percentile (`atr_percentile_1y` from vision,
 *    `atr_percentile_window` from the series) collapse to `atr_percentile`,
 *  - `kind` tells a reader which prompt produced the row, because a field that
 *    is structurally absent from a vision read (`close_at_generation`) and one
 *    the model could not compute are not the same thing.
 *
 * This lives in packages/shared because it is the contract on both sides of
 * the wire: apps/api validates the model's json into it and stores it in
 * `analyses.analysis_result`, and apps/web reads that column back and renders
 * it. A divergence between the two must be a compile error.
 *
 * The zod schemas that parse the raw model output into this shape live in
 * apps/api/src/services/analysis-schema.ts, next to the prompts they mirror.
 */

/** Which prompt produced a result — a screenshot read, or an exact candle series. */
export type AnalysisKind = 'vision' | 'computed';

export type ChartType =
  | 'candlestick'
  | 'ohlc_bar'
  | 'line'
  | 'heikin_ashi'
  | 'renko'
  | 'other';

export type AxisState = 'calibrated' | 'partial' | 'unreadable';

export type InstrumentType =
  | 'equity'
  | 'index'
  | 'futures'
  | 'option'
  | 'crypto'
  | 'fx'
  | 'commodity';

export type AnalysisTimeframe = 'm1' | 'm5' | 'm15' | 'h1' | 'h4' | 'd1' | 'w1';

export type StructureState = 'uptrend' | 'downtrend' | 'range' | 'transition';

export type StructureClarity = 'high' | 'medium' | 'low';

export type LevelKind = 'support' | 'resistance';

export type Persistence = 'trending' | 'choppy';

export type SetupFormat = 'confirmed' | 'conditional' | 'two_scenario' | 'none';

export type TriggerCondition = 'close_above' | 'close_below' | 'already_triggered';

export type ScenarioDirection = 'long' | 'short';

export type TargetBasis = 'prior_swing' | 'range_edge' | 'measured_move' | 'atr_multiple';

/**
 * The reason codes the prompts enumerate. Kept as a union so a code the model
 * invents fails validation instead of reaching the UI as an unlabelled string,
 * and so the copy map in apps/web is exhaustive by construction.
 */
export const ANALYSIS_REASON_CODES = [
  'axis_unreadable',
  'axis_partial',
  'too_few_candles',
  'no_volume_pane',
  'chart_type_unsupported',
  'timeframe_unknown',
  'symbol_unresolved',
  'no_history',
  'illiquid',
  'not_a_chart',
  'heavy_annotation',
  'price_mid_range',
  'signals_conflict',
  'expiry_imminent',
] as const;

export type AnalysisReasonCode = (typeof ANALYSIS_REASON_CODES)[number];

/**
 * How the read itself went, before anything it concluded.
 *
 * The vision-only and series-only members are `null` on the other kind rather
 * than absent, so a renderer never has to narrow on `kind` just to read a
 * field it will only show when it is present.
 */
export interface AnalysisMeta {
  /** Echo of the id passed with the request; null on the series path. */
  chart_id: string | null;
  /** The ticker exactly as printed on the chart / passed with the series. */
  symbol_text: string | null;
  /** null when the vision prompt could not tell what kind of chart it is. */
  chart_type: ChartType | null;
  axis_state: AxisState;
  candles_visible: number | null;
  volume_pane: boolean | null;
  /** Vision only: the model's own price-read error, as a percentage of price. */
  price_read_error_pct: number | null;
  /** Series only: a close-to-close gap that looks like a split/bonus artifact. */
  corporate_action_suspected: boolean | null;
  /** Series only: the last close the whole read is measured against. */
  close_at_generation: number | null;
  /** Conditions that degraded or blocked the read (vision `blockers`). */
  blockers: AnalysisReasonCode[];
  /** Free-text caveats the series path attaches (series `notes`). */
  notes: string[];
}

export interface AnalysisIdentity {
  symbol_text: string | null;
  /** Resolution against an exchange master list; null from the vision prompt. */
  resolved_symbol: string | null;
  instrument_type: InstrumentType | null;
  timeframe: AnalysisTimeframe | null;
  expiry_days: number | null;
}

/**
 * One support/resistance ZONE. Never a point: the prompts require a band, both
 * because liquidity clusters around a focal price rather than at it and
 * because the model's own read of that price carries error.
 */
export interface AnalysisLevel {
  low: number;
  high: number;
  kind: LevelKind;
  /** Distinct wick or body reactions into the zone. */
  touches: number;
  /** Distance from the last close to the near edge, in ATR units. */
  dist_atr: number | null;
  /** Which path produced it — a vision read, or a measurement of exact candles. */
  source: AnalysisKind;
}

export interface AnalysisStructure {
  state: StructureState | null;
  clarity: StructureClarity;
  /** Where the last close sits in the visible range: 0 at the low, 1 at the high. */
  range_position: number | null;
  levels: AnalysisLevel[];
}

export interface AnalysisRegime {
  atr_pct: number | null;
  /**
   * Current ATR as a percentile of the window's own ATR values, 0–1.
   * `atr_percentile_1y` from the vision prompt (always unknown there) and
   * `atr_percentile_window` from the series prompt collapse into this.
   */
  atr_percentile: number | null;
  volume_vs_median: number | null;
  persistence: Persistence | null;
  /** Requires spread/ADV neither prompt has, so always null until a computed path fills it. */
  liquidity_ok: boolean | null;
}

/**
 * One conditional trade geometry. Note what is NOT here: no confidence, no
 * R:R, no position size. `p_target_before_invalidation` is the only
 * probability either prompt is allowed to emit, and it is explicitly
 * conditional on the trigger firing.
 */
export interface AnalysisScenario {
  id: string;
  trigger: TriggerCondition;
  /** The trigger is a band around the level zone, not a price. */
  trigger_low: number;
  trigger_high: number;
  direction: ScenarioDirection;
  invalidation: number;
  target: number | null;
  target_basis: TargetBasis;
  /** An untested level zone sitting between trigger and target, if any. */
  obstacle: number | null;
  /** P(target touched before invalidation | trigger fires), bounded 0.1–0.55. */
  p_target_before_invalidation: number;
  horizon_candles: number;
}

export interface AnalysisSetup {
  format: SetupFormat;
  /** Set only when format is 'none' — why the read supports no scenario. */
  abstain_reason: AnalysisReasonCode | null;
  /** Empty when format is 'none'; one scenario normally, two for 'two_scenario'. */
  scenarios: AnalysisScenario[];
}

/**
 * Analogues counted within the window the model was actually given. All three
 * fields are null together — the prompts forbid reporting a hit rate off fewer
 * than 20 counted analogues, and forbid estimating one from memory at all.
 */
export interface AnalysisBaseRate {
  n_analogues: number | null;
  hit_rate: number | null;
  definition: string | null;
}

export interface AnalysisResult {
  kind: AnalysisKind;
  meta: AnalysisMeta;
  identity: AnalysisIdentity;
  structure: AnalysisStructure;
  regime: AnalysisRegime;
  setup: AnalysisSetup;
  /** The observable condition that would prove this read wrong. */
  falsifier: string;
  base_rate: AnalysisBaseRate;
  /** One or two sentences of pure prose — no numbers, by prompt rule. */
  summary: string;
}

/**
 * The scenario a single-line summary should quote: the one the setup actually
 * leads with. `two_scenario` has no single answer by definition, so callers
 * that must pick one take the first — which the prompts order as the primary.
 */
export function primaryScenario(result: AnalysisResult): AnalysisScenario | null {
  return result.setup.scenarios[0] ?? null;
}

/**
 * The stored `call_direction` for a result, or null when there is no single
 * direction to store.
 *
 * 'hold' is how public.call_direction spells an abstention, and an abstention
 * is a deliberately common answer under these prompts — a setup format of
 * 'none' is a valid, high-quality result, not a missing one.
 *
 * A 'two_scenario' read is the case with no answer: it exists precisely
 * because both edges are live and the chart does not say which one resolves.
 * Storing its first scenario's direction would turn "either way" into a call
 * the model never made, so it stores nothing and readers fall back to
 * `setup.format`.
 */
export function callDirectionFor(result: AnalysisResult): ScenarioDirection | 'hold' | null {
  if (result.setup.format === 'none') return 'hold';
  if (result.setup.format === 'two_scenario') return null;
  return primaryScenario(result)?.direction ?? null;
}
