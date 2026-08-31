import type { AnalysisAiResult } from "../../services/ai-analysis.service.js";

export interface BriefingItem {
  symbol: string;
  name: string;
  marketDataDate: string; // YYYY-MM-DD
  latestPrice: number;
  analysis: AnalysisAiResult;
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

function formatDirection(direction: AnalysisAiResult["call"]["direction"]): string {
  return direction.toUpperCase();
}

function itemHtml(item: BriefingItem): string {
  const call = item.analysis.call;
  const levels = [
    item.analysis.support_levels.length > 0
      ? `Support: ${item.analysis.support_levels.join(", ")}`
      : null,
    item.analysis.resistance_levels.length > 0
      ? `Resistance: ${item.analysis.resistance_levels.join(", ")}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return `
    <tr>
      <td style="padding:16px 0;border-bottom:1px solid #e2e2e2;">
        <div style="font-size:16px;font-weight:600;color:#111;">
          ${escapeHtml(item.symbol)} — ${escapeHtml(item.name)}
        </div>
        <div style="font-size:13px;color:#666;margin-top:2px;">
          As of ${escapeHtml(item.marketDataDate)} · Close ${item.latestPrice}
        </div>
        <div style="font-size:14px;margin-top:8px;">
          <strong>${formatDirection(call.direction)}</strong>
          (confidence ${(call.confidence * 100).toFixed(0)}%)
        </div>
        ${levels ? `<div style="font-size:13px;color:#444;margin-top:4px;">${escapeHtml(levels)}</div>` : ""}
        <div style="font-size:14px;color:#222;margin-top:8px;">${escapeHtml(item.analysis.summary)}</div>
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
