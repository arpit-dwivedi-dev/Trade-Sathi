import type { AnalysisResult } from "@tradesathi/shared";

export interface BriefingItem {
  symbol: string;
  name: string;
  marketDataDate: string; // YYYY-MM-DD
  latestPrice: number;
  analysis: AnalysisResult;
}

export interface FailedBriefingItem {
  symbol: string;
  name: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * A price band, written the way the prompts insist levels be read: as a zone,
 * never a point. A collapsed band (low === high) prints as one number rather
 * than "1402 – 1402".
 */
function band(low: number, high: number): string {
  return low === high ? String(low) : `${low} – ${high}`;
}

/**
 * The headline for one instrument.
 *
 * There is no confidence percentage here any more, and that is the point: the
 * prompts emit no confidence for a call. The one probability they may report
 * is conditional on the trigger firing, so it is only ever shown next to the
 * trigger it depends on — never as a standalone score for the instrument.
 */
function verdictHtml(analysis: AnalysisResult): string {
  const setup = analysis.setup;

  if (setup.format === "none") {
    const reason = setup.abstain_reason ? ` (${setup.abstain_reason.replace(/_/g, " ")})` : "";
    return `<strong>NO SETUP</strong>${escapeHtml(reason)}`;
  }

  const label = setup.format === "two_scenario" ? "TWO SCENARIOS" : setup.format.toUpperCase();
  const lines = setup.scenarios.map((scenario) => {
    const target = scenario.target !== null ? ` → ${scenario.target}` : "";
    return `<div style="font-size:13px;color:#444;margin-top:4px;">
        ${scenario.direction.toUpperCase()} on ${escapeHtml(scenario.trigger.replace(/_/g, " "))}
        ${band(scenario.trigger_low, scenario.trigger_high)}${target},
        invalid below/above ${scenario.invalidation}
        · p ${scenario.p_target_before_invalidation.toFixed(2)} within ${scenario.horizon_candles} candles
      </div>`;
  });

  return `<strong>${label}</strong>${lines.join("")}`;
}

/** At most three zones, nearest the last close first — the prompts' own order. */
function levelsHtml(analysis: AnalysisResult): string {
  const zones = analysis.structure.levels;
  if (zones.length === 0) return "";

  const text = zones
    .map((zone) => `${zone.kind === "support" ? "S" : "R"} ${band(zone.low, zone.high)}`)
    .join(" · ");
  return `<div style="font-size:13px;color:#444;margin-top:4px;">${escapeHtml(text)}</div>`;
}

function itemHtml(item: BriefingItem): string {
  const structure = item.analysis.structure.state ?? "structure unclear";
  const atr = item.analysis.regime.atr_pct;

  return `
    <tr>
      <td style="padding:16px 0;border-bottom:1px solid #e2e2e2;">
        <div style="font-size:16px;font-weight:600;color:#111;">
          ${escapeHtml(item.symbol)} — ${escapeHtml(item.name)}
        </div>
        <div style="font-size:13px;color:#666;margin-top:2px;">
          As of ${escapeHtml(item.marketDataDate)} · Close ${item.latestPrice}
          · ${escapeHtml(structure)}${atr !== null ? ` · ATR ${atr}%` : ""}
        </div>
        <div style="font-size:14px;margin-top:8px;">${verdictHtml(item.analysis)}</div>
        ${levelsHtml(item.analysis)}
        <div style="font-size:14px;color:#222;margin-top:8px;">${escapeHtml(item.analysis.summary)}</div>
        <div style="font-size:12px;color:#666;margin-top:6px;">
          Wrong if: ${escapeHtml(item.analysis.falsifier)}
        </div>
      </td>
    </tr>`;
}

function failedItemHtml(item: FailedBriefingItem): string {
  return `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #e2e2e2;color:#999;font-size:13px;">
        ${escapeHtml(item.symbol)} — ${escapeHtml(item.name)}: unavailable today
      </td>
    </tr>`;
}

/**
 * Builds one plain, inline-styled HTML email — no template engine, no new
 * design system, per the product spec. Reuses the existing Resend client
 * (resend-client.ts) for delivery.
 */
export function buildDailyBriefingEmail(
  briefingDate: string,
  items: BriefingItem[],
  failedItems: FailedBriefingItem[],
): { subject: string; html: string } {
  const subject = `Your Daily Briefing — ${briefingDate}`;

  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:600px;margin:0 auto;">
      <h1 style="font-size:20px;color:#111;">Daily Briefing — ${escapeHtml(briefingDate)}</h1>
      <table style="width:100%;border-collapse:collapse;">
        ${items.map(itemHtml).join("")}
        ${failedItems.map(failedItemHtml).join("")}
      </table>
      <p style="font-size:12px;color:#999;margin-top:24px;">
        Automated analysis, generated from the latest completed market session.
        Not financial advice.
      </p>
    </div>`;

  return { subject, html };
}
