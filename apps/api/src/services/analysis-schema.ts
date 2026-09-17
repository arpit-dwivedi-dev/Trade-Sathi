import { z } from "zod";
import {
  ANALYSIS_REASON_CODES,
  type AnalysisLevel,
  type AnalysisReasonCode,
  type AnalysisResult,
} from "@tradesathi/shared";

/**
 * The zod mirrors of the two prompts in ../prompts, and the normaliser that
 * turns either one into the single `AnalysisResult` the rest of the system
 * stores and renders.
 *
 * These schemas exist to be edited in lockstep with the prompt text next to
 * them: every key here appears in "THE JSON SHAPE" of one of those prompts,
 * at the same nesting, with the same union members. If you change a prompt,
 * change the matching schema in the same commit — a field the prompt promises
 * and the schema rejects fails the user's analysis outright, and one the
 * schema accepts but the prompt never mentions is a field nothing produces.
 *
 * HOW STRICT, AND WHY
 *
 * Validation failure is not free: it costs the user the entitlement already
 * spent on the run (see processAnalysis's note on why quota is not refunded
 * on AI failure). So the rules below are deliberately graded:
 *
 *  - Enumerations, nesting and types are strict. `strictObject` rejects an
 *    unexpected key rather than dropping it, so a model drifting from the
 *    contract surfaces as a `schema_validation` failure instead of a
 *    half-saved row.
 *  - Bounds the prompts state as hard limits (a probability in 0.1–0.55, a
 *    horizon of 1–50 candles, a range position in 0–1) are enforced. A value
 *    outside them is not a near miss; it is the model ignoring the one
 *    discipline the prompt is built around.
 *  - Coherence the prompts promise is enforced: a zone whose low exceeds its
 *    high, or a "long" whose target sits below its trigger, would render as a
 *    confident, precise, wrong picture. Better to fail and let the provider
 *    chain retry.
 *  - Counts that are advisory are repaired, not rejected: levels beyond the
 *    third are sliced off (they are ordered nearest-close-first, so the tail
 *    is exactly what the cap meant to drop).
 *  - Reason codes that are not in the enumerated list are dropped rather than
 *    rejected. They are labels on an answer, not the answer, and losing one
 *    caption is a far smaller harm than failing an otherwise good read.
 */

/* -------------------------------------------------------------------------- */
/* Shared building blocks                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Both prompts spell an unreadable value as the literal string "unknown"
 * rather than null, deliberately: it is a positive statement that the model
 * looked and could not tell, distinct from a key it forgot. Downstream, that
 * distinction has already served its purpose, so it collapses to null here —
 * a renderer should not have to ask whether a number is a number.
 */
function unknownable<T extends z.ZodTypeAny>(schema: T) {
  return z
    .union([schema, z.literal("unknown")])
    .transform((value) => (value === "unknown" ? null : (value as z.infer<T>)));
}

const REASON_CODES: ReadonlySet<string> = new Set(ANALYSIS_REASON_CODES);

function isReasonCode(value: string): value is AnalysisReasonCode {
  return REASON_CODES.has(value);
}

/** Unrecognised codes are dropped — see "HOW STRICT" above. */
const reasonCodeList = z
  .array(z.string())
  .transform((codes) => codes.filter(isReasonCode));

const reasonCode = z
  .string()
  .nullable()
  .transform((value) => (value !== null && isReasonCode(value) ? value : null));

const CHART_TYPES = [
  "candlestick",
  "ohlc_bar",
  "line",
  "heikin_ashi",
  "renko",
  "other",
] as const;

const INSTRUMENT_TYPES = [
  "equity",
  "index",
  "futures",
  "option",
  "crypto",
  "fx",
  "commodity",
] as const;

const TIMEFRAMES = ["m1", "m5", "m15", "h1", "h4", "d1", "w1"] as const;

const STRUCTURE_STATES = ["uptrend", "downtrend", "range", "transition"] as const;

const clarity = z.enum(["high", "medium", "low"]);

const persistence = z.enum(["trending", "choppy"]);

/** 0 at the visible low, 1 at the visible high. */
const rangePosition = z.number().min(0).max(1);

const setupFormat = z.enum(["confirmed", "conditional", "two_scenario", "none"]);

/**
 * One support/resistance zone, parameterised by which path produced it — the
 * prompts hardcode `source` per path ("vision" / "computed"), so the literal
 * is part of the contract rather than a free field.
 */
function levelSchema(source: "vision" | "computed") {
  return z
    .strictObject({
      low: z.number(),
      high: z.number(),
      kind: z.enum(["support", "resistance"]),
      touches: z.number().int().min(0),
      dist_atr: unknownable(z.number()),
      source: z.literal(source),
    })
    // A band, by definition. An inverted one is not a near miss: every reader
    // downstream treats `low` as the near edge for a support and `high` as the
    // near edge for a resistance, and would silently draw the zone backwards.
    .refine((level) => level.low <= level.high, {
      message: "level.low must not exceed level.high",
    });
}

/**
 * One scenario. The internal-coherence rules are the prompts' own words
 * ("long means trigger_low > invalidation and target > trigger_high; short is
 * the mirror") — a scenario that breaks them describes a trade whose stop is
 * on the same side as its target.
 */
const scenarioSchema = z
  .strictObject({
    id: z.string().min(1),
    trigger: z.enum(["close_above", "close_below", "already_triggered"]),
    trigger_low: z.number(),
    trigger_high: z.number(),
    direction: z.enum(["long", "short"]),
    invalidation: z.number(),
    target: z.number().nullable(),
    target_basis: z.enum(["prior_swing", "range_edge", "measured_move", "atr_multiple"]),
    obstacle: z.number().nullable(),
    // The only probability either prompt may emit, and the bounds are the
    // point of it: "setup hit rates above this are not supported by evidence".
    p_target_before_invalidation: z.number().min(0.1).max(0.55),
    horizon_candles: z.number().int().min(1).max(50),
  })
  .superRefine((scenario, ctx) => {
    if (scenario.trigger_low > scenario.trigger_high) {
      ctx.addIssue({
        code: "custom",
        path: ["trigger_low"],
        message: "trigger_low must not exceed trigger_high",
      });
    }

    const long = scenario.direction === "long";
    const invalidationOk = long
      ? scenario.invalidation < scenario.trigger_low
      : scenario.invalidation > scenario.trigger_high;
    if (!invalidationOk) {
      ctx.addIssue({
        code: "custom",
        path: ["invalidation"],
        message: `invalidation must sit on the far side of the trigger for a ${scenario.direction}`,
      });
    }

    if (scenario.target !== null) {
      const targetOk = long
        ? scenario.target > scenario.trigger_high
        : scenario.target < scenario.trigger_low;
      if (!targetOk) {
        ctx.addIssue({
          code: "custom",
          path: ["target"],
          message: `target must sit beyond the trigger in the direction of a ${scenario.direction}`,
        });
      }
    }
  });

/**
 * The setup block, shared verbatim by both prompts.
 *
 * The scenario count is checked against the format because the format is a
 * claim about the count: "none" promises no forward numbers at all, and
 * "two_scenario" exists precisely because there are two edges in play. A
 * mismatch means one of the two fields is lying about the other.
 */
const setupSchema = z
  .strictObject({
    format: setupFormat,
    abstain_reason: reasonCode,
    scenarios: z.array(scenarioSchema).max(2),
  })
  .superRefine((setup, ctx) => {
    const count = setup.scenarios.length;
    if (setup.format === "none" && count !== 0) {
      ctx.addIssue({
        code: "custom",
        path: ["scenarios"],
        message: "an abstaining setup must carry no scenarios",
      });
    }
    if (setup.format !== "none" && count === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["scenarios"],
        message: `setup format '${setup.format}' requires at least one scenario`,
      });
    }
    if (count === 2 && setup.format !== "two_scenario") {
      ctx.addIssue({
        code: "custom",
        path: ["scenarios"],
        message: "two scenarios are only valid for the 'two_scenario' format",
      });
    }
  })
  .transform((setup) => ({
    ...setup,
    // An abstain_reason on a live setup is noise the UI would have to hide;
    // dropping it here keeps "there is a reason" and "the setup abstained"
    // the same question.
    abstain_reason: setup.format === "none" ? setup.abstain_reason : null,
  }));

/** Prose the report leans on, so an empty string is a failure, not a value. */
const falsifier = z.string().min(1);

/** Under 180 characters and pure prose, per both prompts. */
const summary = z.string().min(1);

/* -------------------------------------------------------------------------- */
/* The vision prompt — prompts/chart-analysis.ts                               */
/* -------------------------------------------------------------------------- */

export const VisionAnalysisSchema = z.strictObject({
  meta: z.strictObject({
    chart_id: z.string(),
    chart_type: unknownable(z.enum(CHART_TYPES)),
    axis_state: z.enum(["calibrated", "partial", "unreadable"]),
    candles_visible: unknownable(z.number().int().min(0)),
    volume_pane: unknownable(z.boolean()),
    price_read_error_pct: unknownable(z.number().min(0)),
    blockers: reasonCodeList,
  }),
  identity: z.strictObject({
    symbol_text: z.string().nullable(),
    resolved_symbol: unknownable(z.string()),
    instrument_type: unknownable(z.enum(INSTRUMENT_TYPES)),
    timeframe: unknownable(z.enum(TIMEFRAMES)),
    expiry_days: unknownable(z.number().int()),
  }),
  structure: z.strictObject({
    state: unknownable(z.enum(STRUCTURE_STATES)),
    clarity,
    range_position: unknownable(rangePosition),
    levels: z.array(levelSchema("vision")),
  }),
  regime: z.strictObject({
    atr_pct: unknownable(z.number().min(0)),
    // Pinned to the literal by the prompt: a one-year percentile needs history
    // no screenshot carries, and a number here would be invented.
    atr_percentile_1y: z.literal("unknown"),
    volume_vs_median: unknownable(z.number().min(0)),
    persistence: unknownable(persistence),
    liquidity_ok: z.literal("unknown"),
  }),
  setup: setupSchema,
  falsifier,
  base_rate: z.strictObject({
    n_analogues: z.literal("unknown"),
    hit_rate: z.literal("unknown"),
    definition: z.null(),
  }),
  summary,
});

/* -------------------------------------------------------------------------- */
/* The candle-series prompt — prompts/candle-analysis.ts                       */
/* -------------------------------------------------------------------------- */

export const SeriesAnalysisSchema = z.strictObject({
  meta: z.strictObject({
    symbol_text: z.string(),
    // Pinned: the series path builds the candles itself, so these three
    // describe the input rather than a reading of it.
    chart_type: z.literal("candlestick"),
    axis_state: z.literal("calibrated"),
    candles_visible: z.number().int().min(0),
    volume_pane: z.literal(true),
    corporate_action_suspected: z.boolean(),
    close_at_generation: z.number(),
    notes: z.array(z.string()),
  }),
  identity: z.strictObject({
    symbol_text: z.string(),
    resolved_symbol: z.string(),
    instrument_type: z.enum(INSTRUMENT_TYPES),
    timeframe: z.enum(TIMEFRAMES),
    expiry_days: unknownable(z.number().int()),
  }),
  structure: z.strictObject({
    // "unknown" is not in this prompt's shape line, but its own state rule
    // ("Requires at least 30 candles, else 'unknown'") puts it there.
    state: unknownable(z.enum(STRUCTURE_STATES)),
    clarity,
    range_position: unknownable(rangePosition),
    levels: z.array(levelSchema("computed")),
  }),
  regime: z.strictObject({
    atr_pct: unknownable(z.number().min(0)),
    atr_percentile_window: unknownable(z.number().min(0).max(1)),
    volume_vs_median: unknownable(z.number().min(0)),
    persistence: unknownable(persistence),
    liquidity_ok: z.literal("unknown"),
  }),
  setup: setupSchema,
  falsifier,
  base_rate: z
    .strictObject({
      n_analogues: unknownable(z.number().int().min(0)),
      hit_rate: unknownable(z.number().min(0).max(1)),
      definition: z.string().nullable(),
    })
    // "If n_analogues < 20, all three fields: unknown, definition null." A
    // hit rate off a handful of analogues is noise presented as evidence, so
    // it is dropped here rather than trusted to have been dropped upstream.
    .transform((rate) =>
      rate.n_analogues === null || rate.n_analogues < 20
        ? { n_analogues: null, hit_rate: null, definition: null }
        : rate,
    ),
  summary,
});

export type VisionAnalysis = z.infer<typeof VisionAnalysisSchema>;
export type SeriesAnalysis = z.infer<typeof SeriesAnalysisSchema>;

/* -------------------------------------------------------------------------- */
/* Normalisation into the stored shape                                         */
/* -------------------------------------------------------------------------- */

/**
 * At most three zones, nearest the last close first — both prompts' cap.
 * Sliced rather than rejected: the ordering means the tail is exactly what the
 * cap was asking the model to leave out.
 */
function cappedLevels(levels: AnalysisLevel[]): AnalysisLevel[] {
  return levels.slice(0, 3);
}

/** Structurally identical on both paths once each has been parsed. */
function normalizeSetup(setup: VisionAnalysis["setup"]): AnalysisResult["setup"] {
  return {
    format: setup.format,
    abstain_reason: setup.abstain_reason,
    scenarios: setup.scenarios,
  };
}

export function normalizeVisionAnalysis(parsed: VisionAnalysis): AnalysisResult {
  return {
    kind: "vision",
    meta: {
      chart_id: parsed.meta.chart_id,
      // The vision prompt keeps the ticker under identity; meta carries the
      // chart id instead. Mirrored here so one field answers "what was this"
      // regardless of which path produced the row.
      symbol_text: parsed.identity.symbol_text,
      chart_type: parsed.meta.chart_type,
      axis_state: parsed.meta.axis_state,
      candles_visible: parsed.meta.candles_visible,
      volume_pane: parsed.meta.volume_pane,
      price_read_error_pct: parsed.meta.price_read_error_pct,
      corporate_action_suspected: null,
      close_at_generation: null,
      blockers: parsed.meta.blockers,
      notes: [],
    },
    identity: {
      symbol_text: parsed.identity.symbol_text,
      resolved_symbol: parsed.identity.resolved_symbol,
      instrument_type: parsed.identity.instrument_type,
      timeframe: parsed.identity.timeframe,
      expiry_days: parsed.identity.expiry_days,
    },
    structure: {
      state: parsed.structure.state,
      clarity: parsed.structure.clarity,
      range_position: parsed.structure.range_position,
      levels: cappedLevels(parsed.structure.levels),
    },
    regime: {
      atr_pct: parsed.regime.atr_pct,
      atr_percentile: null,
      volume_vs_median: parsed.regime.volume_vs_median,
      persistence: parsed.regime.persistence,
      liquidity_ok: null,
    },
    setup: normalizeSetup(parsed.setup),
    falsifier: parsed.falsifier,
    base_rate: { n_analogues: null, hit_rate: null, definition: null },
    summary: parsed.summary,
  };
}

export function normalizeSeriesAnalysis(parsed: SeriesAnalysis): AnalysisResult {
  return {
    kind: "computed",
    meta: {
      chart_id: null,
      symbol_text: parsed.meta.symbol_text,
      chart_type: parsed.meta.chart_type,
      axis_state: parsed.meta.axis_state,
      candles_visible: parsed.meta.candles_visible,
      volume_pane: parsed.meta.volume_pane,
      price_read_error_pct: null,
      corporate_action_suspected: parsed.meta.corporate_action_suspected,
      close_at_generation: parsed.meta.close_at_generation,
      blockers: [],
      notes: parsed.meta.notes,
    },
    identity: {
      symbol_text: parsed.identity.symbol_text,
      resolved_symbol: parsed.identity.resolved_symbol,
      instrument_type: parsed.identity.instrument_type,
      timeframe: parsed.identity.timeframe,
      expiry_days: parsed.identity.expiry_days,
    },
    structure: {
      state: parsed.structure.state,
      clarity: parsed.structure.clarity,
      range_position: parsed.structure.range_position,
      levels: cappedLevels(parsed.structure.levels),
    },
    regime: {
      atr_pct: parsed.regime.atr_pct,
      atr_percentile: parsed.regime.atr_percentile_window,
      volume_vs_median: parsed.regime.volume_vs_median,
      persistence: parsed.regime.persistence,
      liquidity_ok: null,
    },
    setup: normalizeSetup(parsed.setup),
    falsifier: parsed.falsifier,
    base_rate: parsed.base_rate,
    summary: parsed.summary,
  };
}
