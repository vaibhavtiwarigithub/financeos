// The opt-in daily risk email.
//
// Spec: features/per-user-broker-risk/FEATURE_ARCHITECTURE.md §5. Built ONLY
// from the recipient's own `user_holding_risk_*` rows. The owner's book,
// research and signals are deliberately absent: including them would turn a
// description of what someone already holds into a suggestion about what to
// hold, which is the line this feature does not cross.
//
// WHY THE DIAL IS A TABLE AND NOT AN SVG. Gmail strips <svg> entirely, so an
// inline-SVG dial renders as a blank gap for a large share of recipients. The
// page uses a real SVG dial; here the same numbers drive a segmented bar built
// from table cells, which every mail client renders. Both read their band and
// position from lib/risk/risk-gauge.ts, so they cannot disagree.
//
// No LLM: the prose is templated from stored figures (see §6 — a guest-triggered
// path may not call one), and an explanation that could drift from the number it
// explains would be worse than none.

import {
  BANDS, BAND_COLORS, bandFor, clampScore, needleFraction,
  explainPortfolioRisk, riskHeadline, type ExplainInput,
} from "@/lib/risk/risk-gauge";

export type RiskEmailInput = {
  asOfDate: string | null;
  market: "us" | "india";
  currency: string;
  riskScore: number;
  totalValue: number;
  var95_dollar: number;
  portfolioBeta: number;
  holdingCount: number;
  sectorBreakdown?: Array<{ sector: string; pct?: number; weightPct?: number }>;
  holdings?: ExplainInput["holdings"];
  /** Previous run's score, when there is one — movement is the point of a daily email. */
  previousScore?: number | null;
  /** Stated, never hidden: figures computed from a stale broker session. */
  staleNote?: string | null;
  /** Cache-only movers among the recipient's own holdings. Partial by design. */
  movers?: {
    gainers: Array<{ symbol: string; changePct: number }>;
    losers: Array<{ symbol: string; changePct: number }>;
    uncovered: string[];
  } | null;
  appBaseUrl: string;
  unsubscribeToken: string;
};

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function riskEmailSubject(input: RiskEmailInput): string {
  return `Your portfolio: ${riskHeadline(input.riskScore, input.currency, input.var95_dollar)}`;
}

/** The segmented bar + marker that stands in for the dial. Table-only. */
function gaugeHtml(score: number): string {
  const frac = needleFraction(score);
  const band = bandFor(score);
  const cells = BANDS.map((b) => {
    const color = BAND_COLORS[b.band];
    const on = b.band === band;
    return `<td width="25%" height="14" bgcolor="${color}" style="font-size:0;line-height:0;`
      + `opacity:${on ? "1" : "0.35"};border-radius:2px;">&nbsp;</td>`;
  }).join('<td width="4" style="font-size:0;line-height:0;">&nbsp;</td>');

  // The marker is a full-width table with the pointer pushed by a percentage
  // spacer cell — percentages are the one positioning primitive mail clients
  // agree on.
  const left = Math.round(frac * 100);
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr><td>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${cells}</tr></table>
    </td></tr>
    <tr><td style="padding-top:4px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td width="${left}%" style="font-size:0;line-height:0;">&nbsp;</td>
        <td style="font-size:14px;line-height:14px;color:#111;white-space:nowrap;">&#9650;</td>
        <td style="font-size:0;line-height:0;">&nbsp;</td>
      </tr></table>
    </td></tr>
    <tr><td style="padding-top:2px;font:600 11px Arial,sans-serif;color:#6B7280;">
      Lower risk &nbsp;&#8212;&nbsp; Higher risk
    </td></tr>
  </table>`;
}

function movementLine(score: number, previous: number | null | undefined): string {
  if (previous == null || !Number.isFinite(previous)) {
    return `<span style="color:#6B7280;">First reading — there is nothing to compare it with yet.</span>`;
  }
  const delta = clampScore(score) - clampScore(previous);
  if (Math.abs(delta) < 0.5) return `<span style="color:#6B7280;">Unchanged since the last reading.</span>`;
  const up = delta > 0;
  return `<span style="color:${up ? "#B45309" : "#15803D"};font-weight:600;">`
    + `${up ? "▲" : "▼"} ${Math.abs(delta).toFixed(0)} points ${up ? "riskier" : "less risky"} than last time`
    + `</span> <span style="color:#6B7280;">(was ${Math.round(clampScore(previous))})</span>`;
}


/**
 * Yesterday's movers among the recipient's own holdings, from cache only.
 *
 * When some holdings have no cached pair the block SAYS the list is partial.
 * A leaderboard that silently dropped the worst loser because it happened to be
 * uncached would be worse than no leaderboard at all.
 */
function moversHtml(input: RiskEmailInput): string {
  const m = input.movers;
  if (!m || (!m.gainers.length && !m.losers.length)) return "";
  const pct = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(2)}%`;
  const col = (title: string, rows: Array<{ symbol: string; changePct: number }>, color: string) => `
    <td width="50%" valign="top" style="padding-right:8px;">
      <div style="font:600 11px Arial,sans-serif;color:#6B7280;margin-bottom:4px;">${esc(title)}</div>
      ${rows.length
        ? rows.map((r) => `<div style="font:400 13px Arial,sans-serif;color:#111;padding:3px 0;">
             ${esc(r.symbol)} <span style="color:${color};font-weight:600;float:right;">${pct(r.changePct)}</span>
           </div>`).join("")
        : `<div style="font:400 12px Arial,sans-serif;color:#9CA3AF;">None</div>`}
    </td>`;

  return `
    <tr><td style="padding:18px 24px 0;">
      <div style="font:700 13px Arial,sans-serif;color:#111;margin-bottom:6px;">Your holdings' last session</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        ${col("Top gainers", m.gainers, "#15803D")}
        ${col("Top losers", m.losers, "#B91C1C")}
      </tr></table>
      ${m.uncovered.length ? `<div style="font:400 11px/1.5 Arial,sans-serif;color:#9CA3AF;margin-top:6px;">
        Partial list — no cached prices for ${esc(m.uncovered.join(", "))}, so they are not ranked here.
      </div>` : ""}
    </td></tr>`;
}

export function buildRiskEmailHtml(input: RiskEmailInput): string {
  const score = clampScore(input.riskScore);
  const band = bandFor(score);
  const cur = input.currency;
  const money = (n: number) => `${cur}${Math.round(Math.abs(Number(n) || 0)).toLocaleString()}`;
  const all = explainPortfolioRisk({
    riskScore: score,
    portfolioBeta: input.portfolioBeta,
    holdingCount: input.holdingCount,
    sectorBreakdown: input.sectorBreakdown,
    holdings: input.holdings,
  });
  // Trim DRIVERS for length, but never the caveats. A caveat carries the lowest
  // weight by design, so a naive top-N slice drops "we could not measure this"
  // first — which is the one line whose absence makes the email overclaim.
  const drivers = [
    ...all.filter((d) => d.kind !== "caveat").slice(0, 4),
    ...all.filter((d) => d.kind === "caveat"),
  ];

  const unsubUrl = `${input.appBaseUrl}/api/user-risk/unsubscribe?token=${encodeURIComponent(input.unsubscribeToken)}`;
  const appUrl = `${input.appBaseUrl}/dashboard/my-risk`;

  const driverRows = drivers.map((d) => `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #EEF0F4;">
        <div style="font:600 13px Arial,sans-serif;color:#111;">${esc(d.label)}</div>
        <div style="font:400 13px/1.5 Arial,sans-serif;color:#4B5563;margin-top:2px;">${esc(d.detail)}</div>
      </td>
    </tr>`).join("");

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#F3F4F6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F3F4F6;padding:24px 12px;">
<tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#FFFFFF;border-radius:10px;">
    <tr><td style="padding:22px 24px 8px;">
      <div style="font:700 20px Arial,sans-serif;color:#111;">Your Portfolio Risk</div>
      <div style="font:400 12px Arial,sans-serif;color:#6B7280;margin-top:4px;">
        ${input.market === "india" ? "India" : "US"} &middot; as of ${esc(input.asOfDate ?? "—")}
      </div>
    </td></tr>

    ${input.staleNote ? `
    <tr><td style="padding:0 24px 8px;">
      <div style="background:#FEF3C7;border:1px solid #F59E0B;border-radius:8px;padding:10px 12px;font:400 12px/1.5 Arial,sans-serif;color:#92400E;">
        <strong>These figures are not current.</strong> ${esc(input.staleNote)}
      </div>
    </td></tr>` : ""}

    <tr><td style="padding:8px 24px 0;">
      <div style="font:700 30px Arial,sans-serif;color:${BAND_COLORS[band]};">${Math.round(score)}<span style="font:400 15px Arial,sans-serif;color:#6B7280;">/100</span></div>
      <div style="font:600 14px Arial,sans-serif;color:#111;margin:2px 0 10px;">${band} risk</div>
      ${gaugeHtml(score)}
      <div style="font:400 12px Arial,sans-serif;margin-top:10px;">${movementLine(score, input.previousScore)}</div>
    </td></tr>

    <tr><td style="padding:16px 24px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          ${[
            ["Holdings", String(input.holdingCount)],
            ["Value", money(input.totalValue)],
            ["Bad day (95%)", money(input.var95_dollar)],
            ["Beta", Number(input.portfolioBeta ?? 0).toFixed(2)],
          ].map(([l, v]) => `
          <td width="25%" style="padding:8px 4px;background:#F9FAFB;border-radius:6px;" align="center">
            <div style="font:400 10px Arial,sans-serif;color:#6B7280;">${esc(l)}</div>
            <div style="font:700 14px Arial,sans-serif;color:#111;margin-top:2px;">${esc(v)}</div>
          </td>`).join('<td width="6" style="font-size:0;">&nbsp;</td>')}
        </tr>
      </table>
    </td></tr>

    ${driverRows ? `
    <tr><td style="padding:18px 24px 0;">
      <div style="font:700 13px Arial,sans-serif;color:#111;margin-bottom:4px;">Why it reads this way</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${driverRows}</table>
    </td></tr>` : ""}

    ${moversHtml(input)}

    <tr><td style="padding:18px 24px 4px;">
      <a href="${esc(appUrl)}" style="display:inline-block;background:#4F46E5;color:#FFFFFF;text-decoration:none;font:600 13px Arial,sans-serif;padding:10px 18px;border-radius:6px;">See the full breakdown</a>
    </td></tr>

    <tr><td style="padding:16px 24px 22px;">
      <div style="font:400 11px/1.6 Arial,sans-serif;color:#9CA3AF;border-top:1px solid #EEF0F4;padding-top:12px;">
        This describes the holdings already in your own brokerage account. It is <strong>not investment advice</strong>
        and recommends nothing to buy or sell. Access to your account is read-only.
        <br><a href="${esc(unsubUrl)}" style="color:#6B7280;">Unsubscribe from this daily email</a>
      </div>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}
