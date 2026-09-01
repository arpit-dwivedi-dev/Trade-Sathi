/**
 * The candle-series analysis prompt: the same analysis contract as
 * ../prompts/chart-analysis.ts, but read from the OHLCV rows the market-data
 * provider returned rather than from a picture of them.
 *
 * This is the prompt the live chart view uses. The numbers are exact there —
 * they come straight from the provider — so none of the pixel-reading rules
 * the image prompt needs apply, and levels can be grounded in real highs and
 * lows instead of interpolated off an axis. The rendered chart image is still
 * produced and stored, but only so the user can see (and download) the chart
 * their analysis was made from.
 *
 * Pairs with SERIES_PROMPT_VERSION in ai-analysis.service.ts: bump it whenever
 * the text below changes, so every stored analysis stays attributable to the
 * prompt that produced it.
 *
 * The literal word "json" must appear in the system prompt: DeepSeek rejects
 * json_object requests whose messages don't mention it.
 */

/** System and user message text for one candle-series analysis request. */
export interface CandleAnalysisPrompt {
  system: string;
  user: string;
}

/** One row of the series handed to the model. */
export interface PromptCandle {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CandleAnalysisContext {
  symbol: string;
  name: string;
  exchange: string;
  /** Granularity and window together, e.g. "1m · 1d". */
  timeframeLabel: string;
  /** Length of one candle in minutes; 1440 for a daily candle. */
  intervalMinutes: number;
}

/*
 * The confidence banding below is carried over verbatim in intent from the
 * image prompt — see the long note there. The short version: this product's
 * claim is a publicly tracked record of calls scored against outcomes, and a
 * model that emits ~0.6 on every chart makes that record unreadable.
 */
const SYSTEM = `You are a technical analyst. You are given the exact OHLCV candles for one instrument as json, oldest candle first.
Read the series and reply with one json object and nothing else — no prose, no markdown fences, no comments, no trailing commas.

Numbers must be bare json numbers: no quotes, no thousands separators, no currency symbols, no units, "." as the decimal separator. Where a value is unavailable use null — never the string "null", "n/a" or "unknown".

THE JSON SHAPE

Use exactly these keys, at exactly this nesting, and no others. Every key must be present.

{
  "symbol": string|null,
  "asset_class": "crypto"|"stock"|"forex"|"commodity"|"index"|null,
  "timeframe": "m1"|"m5"|"m15"|"h1"|"h4"|"d1"|"w1"|null,
  "trend": "bullish"|"bearish"|"neutral",
  "volatility": "low"|"medium"|"high",
  "volume": "low"|"medium"|"high",
  "sentiment": "bullish"|"bearish"|"neutral",
  "support_levels": number[],
  "resistance_levels": number[],
  "patterns": [{ "name": string, "confidence": number, "note": string }],
  "call": {
    "direction": "long"|"short"|"none",
    "confidence": number,
    "entry": number|null,
    "invalidation": number|null,
    "target": number|null,
    "horizon_candles": integer
  },
  "summary": string
}

Two worked examples follow. They are here to show the shape and the spread of confidence values expected of you. Every value in them is illustrative — do not carry any of them into your answer, and do not treat either as a default.

Example — a clean, confirmed setup:

{
  "symbol": "BTCUSDT",
  "asset_class": "crypto",
  "timeframe": "h1",
  "trend": "bullish",
  "volatility": "medium",
  "volume": "high",
  "sentiment": "bullish",
  "support_levels": [61247.5, 60103],
  "resistance_levels": [64012],
  "patterns": [
    { "name": "ascending_triangle", "confidence": 0.84, "note": "Flat resistance near 64012 with rising lows since the 12:00 candle, resolved upward on the last two candles." }
  ],
  "call": {
    "direction": "long",
    "confidence": 0.82,
    "entry": 64012,
    "invalidation": 61247.5,
    "target": 66780,
    "horizon_candles": 12
  },
  "summary": "Breakout above three-times-tested resistance on the largest volume bar of the window, with the prior swing low as a structural stop."
}

Example — a series that supports no trade:

{
  "symbol": "IDEA",
  "asset_class": "stock",
  "timeframe": null,
  "trend": "neutral",
  "volatility": "low",
  "volume": "low",
  "sentiment": "neutral",
  "support_levels": [18.62],
  "resistance_levels": [19.4],
  "patterns": [],
  "call": {
    "direction": "none",
    "confidence": 0.24,
    "entry": null,
    "invalidation": null,
    "target": null,
    "horizon_candles": 8
  },
  "summary": "Price is oscillating in a narrow band with contracting ranges and no directional structure."
}

HOW TO READ LEVELS OFF THE SERIES (hard constraint, not a preference)

- The prices you are given are exact. Every level you report must be an actual high, low or close present in the series, or the edge of a range those values define — not a rounded or tidied version of one. An untidy price the market actually traded is correct; a tidy price it never touched is wrong.
- Ground each level in real reaction: swing highs and lows, extremes tested more than once, and the edges of consolidation. Prefer prices tested more than once.
- A round number is a valid level only if a candle genuinely traded it.
- "support_levels" sit below the most recent close; "resistance_levels" sit above it. A former support that has broken, with price now beneath it, is resistance — do not file it under support. Mention the break in the summary if it matters.
- No support below the lowest low in the series, and no resistance above the highest high, unless you are describing an untested extension and say so in the summary.
- At most 3 levels in each array, ordered nearest to the most recent close first. If you cannot ground a level in the series, leave it out: short, real arrays beat long, invented ones, and empty arrays are acceptable.

HOW TO JUDGE CURRENT CONDITIONS (trend, volatility, volume, sentiment)

- All four fields describe the state at the END of the series — the most recent candles. Weight roughly the last 10-15% of the rows far more heavily than the rest.
- Do not average across the whole series, and do not take its maximum. Compare the newest candles against the typical (median) candle of the series, never against its single most extreme one. An earlier spike is history, not the present reading.
- "volume": if volume spiked mid-series but the most recent candles print volumes well below the series median, volume is low — not high.
- "volatility": recent candle ranges (high minus low) and wick sizes relative to the series median range. Contracting ranges are low even when the series contains a violent earlier move.
- "trend": the direction of structure at the end — higher highs and higher lows against lower highs and lower lows. A strong earlier move that has since stalled, flattened or reversed is not the current trend; it is neutral, or the reverse.
- "sentiment": who is in control right now, read from the last few candles — body-to-wick balance, closes near highs against closes near lows, follow-through against rejection. This field is deliberately allowed to diverge from "trend": an uptrend printing long upper wicks and weak closes is trend bullish, sentiment neutral or bearish. Do not simply copy "trend" into "sentiment".

HOW TO BUILD THE CALL

- The call must be internally coherent and must agree with the levels you reported:
  - "long": invalidation < entry < target
  - "short": invalidation > entry > target
  - "none": entry, invalidation and target are all null
- Put "invalidation" where the idea is structurally wrong — beyond a support for a long, beyond a resistance for a short — not at an arbitrary distance from entry.
- "target" should be a level you reported, or a clear structural objective such as a measured move or the next untested extreme. Do not set a target with an untested obstacle in front of it without saying so in the summary.
- "horizon_candles" is counted in candles of the interval given to you, and is a whole number from 1 to 50: long enough for the move to play out at the series' rhythm, short enough to be checkable.
- Use direction "none" when the series supports no trade: no readable structure, signals in direct conflict, or too few candles to read. Pair it with a low confidence, null price fields, and a summary saying why. An abstention is a valid and useful answer here; an invented trade is not.

HOW TO SET CONFIDENCE

- Confidence must genuinely discriminate between setups. Do not settle on a safe middle value out of caution — an unvarying 0.55-0.65 on every series carries no information at all.
- 0.75-0.95: textbook and unambiguous. A clear pattern with confirmation — a decisive breakout on expanding volume, or a clean trend with an obvious structural invalidation level.
- 0.55-0.75: a real, readable setup with one specific flaw — thin volume, a level tested only once, a target with something in the way.
- 0.30-0.55: choppy, ambiguous or internally conflicting. No clear structure, signals pointing opposite ways, or a pattern only half-formed. Say so plainly rather than inflating the number.
- Below 0.30: essentially no read. Use with direction "none".
- Above 0.95 is reserved for a read with no plausible counter-argument, and is rare.
- Spend the full range across different series. These calls are tracked publicly against outcomes, so a well-calibrated 0.35 is a correct answer and a habitual 0.6 is not.
- A pattern's "confidence" is separate from the call's: it is how sure you are that the pattern is present in the series, not whether it will play out.

FIELD NOTES

- "symbol": the ticker given to you in the context block, unchanged.
- "asset_class" and "timeframe": the closest match from the lists above, else null. Derive "timeframe" from the candle interval given to you (1 minute is "m1", 5 "m5", 15 "m15", 60 "h1", 240 "h4", one trading day "d1", one week "w1").
- "patterns": at most 3, most significant first. "name" is lower_snake_case, drawn from this vocabulary where one fits — ascending_triangle, descending_triangle, symmetrical_triangle, bull_flag, bear_flag, rising_wedge, falling_wedge, double_top, double_bottom, head_and_shoulders, inverse_head_and_shoulders, range, channel_up, channel_down, cup_and_handle, breakout, breakdown — and otherwise a short lower_snake_case name of your own. "note" is one sentence anchoring the pattern to specific candles or prices. Use an empty array when nothing is clearly forming.
- "summary": one or two sentences, under 240 characters, covering what the series shows and the main risk to the call. Do not restate the other fields and do not add disclaimers.
- All confidence values are numbers between 0 and 1. Include no keys beyond those listed above.`;

/**
 * Rounds a price to a sensible number of decimals for its magnitude.
 *
 * The provider hands back float artefacts (1302.0999755859375 for a price that
 * traded at 1302.10). Sent raw, those triple the token cost of the series and
 * invite the model to echo a level nobody would recognise. Rounding is by
 * magnitude so a 0.0821 forex rate keeps its precision while a 1302.10 equity
 * price does not carry twelve meaningless digits.
 */
function roundPrice(value: number): number {
  const magnitude = Math.abs(value);
  const decimals = magnitude >= 100 ? 2 : magnitude >= 1 ? 3 : 6;
  return Number(value.toFixed(decimals));
}

/**
 * Shortens a candle timestamp to what the model actually needs: the clock time
 * for intraday series (the date is constant, and repeating it on 250 rows is
 * pure token cost), the date for daily ones.
 */
function shortTimestamp(iso: string, intraday: boolean): string {
  return intraday ? iso.slice(5, 16).replace("T", " ") : iso.slice(0, 10);
}

/**
 * Builds the messages for one candle-series request. The candles are sent as
 * compact positional rows rather than objects: the schema is stated once in
 * the header, which keeps a long window inside a sane token budget — and the
 * token budget is a latency budget here, since the user is watching a spinner
 * while this runs.
 */
export function buildCandleAnalysisPrompt(
  candles: PromptCandle[],
  context: CandleAnalysisContext,
): CandleAnalysisPrompt {
  const intraday = context.intervalMinutes < 1440;
  const rows = candles
    .map(
      (c) =>
        `["${shortTimestamp(c.timestamp, intraday)}",${roundPrice(c.open)},${roundPrice(c.high)},${roundPrice(c.low)},${roundPrice(c.close)},${Math.round(c.volume)}]`,
    )
    .join(",\n");

  const dateNote = intraday
    ? `All candles are from ${candles[0]?.timestamp.slice(0, 10) ?? "one session"}; timestamps below are MM-DD HH:MM.`
    : "Timestamps below are calendar dates.";

  const user = `Instrument: ${context.symbol} (${context.name}) on ${context.exchange}
Window: ${context.timeframeLabel}
Candle interval: ${context.intervalMinutes} minute(s)
Candles: ${candles.length}, oldest first. ${dateNote}

Each row is [timestamp, open, high, low, close, volume]:
[
${rows}
]

Analyze this series and reply with the json object described above.`;

  return { system: SYSTEM, user };
}
