import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkPaused, pausedResponse } from "../_shared/pause-check.ts";

const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const RECIPIENT = "vterminater@gmail.com";
const HOLDINGS_ACCOUNT = "965848641";

// â"€â"€â"€ HTML helpers (email-safe, inline CSS only) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

function scoreBar(score: number, color = "#6366F1"): string {
  const filled = Math.round((score / 100) * 160);
  const empty = 160 - filled;
  return `<table cellpadding="0" cellspacing="0" style="display:inline-table;vertical-align:middle;"><tr><td width="${filled}" style="height:4px;background:${color};border-radius:2px 0 0 2px;"></td><td width="${empty}" style="height:4px;background:#252836;border-radius:0 2px 2px 0;"></td></tr></table>`;
}

function badge(text: string, color: string): string {
  return `<span style="background:${color}22;color:${color};border:1px solid ${color}44;border-radius:4px;font-size:10px;font-weight:700;padding:2px 7px;letter-spacing:0.04em;white-space:nowrap;">${text}</span>`;
}

function dirBadge(dir: string): string {
  if (dir === "long")    return badge("LONG â–²", "#34D399");
  if (dir === "short")   return badge("SHORT â–¼", "#F87171");
  return badge("NEUT â"€", "#9B9EA8");
}

function sentBadge(label: string): string {
  const l = label?.toLowerCase() ?? "";
  if (l.includes("bullish")) return badge("â— Bullish", "#34D399");
  if (l.includes("bearish")) return badge("â— Bearish", "#F87171");
  return badge("â— Neutral", "#9B9EA8");
}

function pColor(n: number): string { return n >= 0 ? "#34D399" : "#F87171"; }
function fmt$(n: number): string { return (n >= 0 ? "+$" : "-$") + Math.abs(n).toFixed(2); }
function fmtPct(n: number): string { return (n >= 0 ? "+" : "") + n.toFixed(2) + "%"; }
function fmtNum(n: number, dec = 2): string { return n.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec }); }

function divider(): string {
  return `<tr><td style="padding:4px 0 16px;"><div style="height:1px;background:#252836;"></div></td></tr>`;
}

function sectionCard(title: string, icon: string, content: string, accent = "#6366F1"): string {
  return `<tr><td style="padding:0 0 16px 0;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#1A1D27;border:1px solid #252836;border-radius:10px;overflow:hidden;">
      <tr><td style="padding:12px 20px 10px;border-bottom:1px solid #252836;background:#141620;">
        <span style="font-size:10px;color:${accent};letter-spacing:0.1em;font-weight:700;text-transform:uppercase;">${icon} ${title}</span>
      </td></tr>
      <tr><td style="padding:16px 20px;">${content}</td></tr>
    </table>
  </td></tr>`;
}

function row2col(left: string, right: string): string {
  return `<table width="100%" cellpadding="0" cellspacing="0"><tr><td style="vertical-align:top;width:50%;padding-right:8px;">${left}</td><td style="vertical-align:top;width:50%;padding-left:8px;">${right}</td></tr></table>`;
}

function statBox(label: string, value: string, sub: string, color = "#ECEDEF"): string {
  return `<div style="background:#0D0F14;border:1px solid #252836;border-radius:8px;padding:12px 16px;">
    <div style="color:#9B9EA8;font-size:10px;text-transform:uppercase;letter-spacing:0.07em;">${label}</div>
    <div style="color:${color};font-size:20px;font-weight:700;margin-top:4px;letter-spacing:-0.02em;">${value}</div>
    ${sub ? `<div style="color:#6B7280;font-size:11px;margin-top:3px;">${sub}</div>` : ""}
  </div>`;
}

function wrapEmail(title: string, dateStr: string, timeStr: string, body: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#0A0C10;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0A0C10;">
<tr><td align="center" style="padding:20px 12px 32px;">
<table width="620" cellpadding="0" cellspacing="0" style="max-width:620px;">

  <!-- Header -->
  <tr><td style="background:linear-gradient(135deg,#1E1F3A,#0D0F14);border:1px solid #252836;border-radius:12px 12px 0 0;padding:24px 28px 20px;">
    <div style="color:#6366F1;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;">â—† Kairos Intelligence</div>
    <div style="color:#ECEDEF;font-size:24px;font-weight:700;margin-top:6px;letter-spacing:-0.02em;">${title}</div>
    <div style="color:#9B9EA8;font-size:12px;margin-top:4px;">${dateStr} &middot; ${timeStr} ET</div>
  </td></tr>

  <!-- Body -->
  <tr><td style="background:#13151C;border:1px solid #252836;border-top:none;border-radius:0 0 12px 12px;padding:20px 20px 4px;">
    <table width="100%" cellpadding="0" cellspacing="0">
      ${body}
    </table>
  </td></tr>

  <!-- Footer -->
  <tr><td style="padding:20px 0 0;text-align:center;">
    <div style="color:#6B7280;font-size:10px;line-height:1.7;">
      Kairos Automated Brief &middot; Paper trading only &middot; Not financial advice<br>
      To: ${RECIPIENT}
    </div>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}

// â"€â"€â"€ Data fetchers â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

async function fetchMarketNews(avKey: string): Promise<any[]> {
  if (!avKey) return [];
  try {
    const r = await fetch(
      `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&topics=earnings,financial_markets,economy_macro&sort=RELEVANCE_SCORE&limit=8&apikey=${avKey}`,
      { signal: AbortSignal.timeout(12000) }
    );
    const json = await r.json();
    return (json?.feed ?? []).slice(0, 6);
  } catch { return []; }
}

async function fetchVOOReturn(avKey: string): Promise<{ price: number; weekReturn: number | null; monthReturn: number | null } | null> {
  if (!avKey) return null;
  try {
    const r = await fetch(
      `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=VOO&outputsize=compact&apikey=${avKey}`,
      { signal: AbortSignal.timeout(12000) }
    );
    const json = await r.json();
    const series = json?.["Time Series (Daily)"] ?? {};
    const dates = Object.keys(series).sort().reverse();
    if (dates.length < 2) return null;

    const latestPrice = parseFloat(series[dates[0]]?.["4. close"]);
    const weekAgo = dates[5] ? parseFloat(series[dates[5]]?.["4. close"]) : null;
    const monthAgo = dates[21] ? parseFloat(series[dates[21]]?.["4. close"]) : null;

    return {
      price: latestPrice,
      weekReturn: weekAgo ? ((latestPrice - weekAgo) / weekAgo) * 100 : null,
      monthReturn: monthAgo ? ((latestPrice - monthAgo) / monthAgo) * 100 : null,
    };
  } catch { return null; }
}

// â"€â"€â"€ Section builders â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

function buildNavSection(nav: number, navDelta: number, navDeltaPct: number, openCount: number, signalCount: number): string {
  const nc = pColor(navDelta);
  return `<tr><td style="padding:0 0 16px 0;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#0D0F14;border:1px solid #6366F133;border-radius:10px;padding:16px 20px;">
      <tr><td>
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="vertical-align:top;width:33%;padding-right:8px;">${statBox("Paper NAV", "$" + fmtNum(nav), navDelta !== 0 ? fmt$(navDelta) + " (" + fmtPct(navDeltaPct) + ") vs yesterday" : "Day 1 baseline", nc)}</td>
            <td style="vertical-align:top;width:33%;padding:0 4px;">${statBox("Open Positions", String(openCount), "Active paper trades", "#6366F1")}</td>
            <td style="vertical-align:top;width:33%;padding-left:8px;">${statBox("Signals Today", String(signalCount), "From research + deepseek agents", "#9B9EA8")}</td>
          </tr>
        </table>
      </td></tr>
    </table>
  </td></tr>`;
}

function buildNewsSection(feed: any[]): string {
  if (feed.length === 0) return sectionCard("Market News", "â—ˆ", `<div style="color:#6B7280;font-size:13px;">No news fetched. AV rate limit or key issue.</div>`);
  let html = "";
  for (const item of feed.slice(0, 5)) {
    const sentLabel = item.overall_sentiment_label ?? "Neutral";
    const sentScore = parseFloat(item.overall_sentiment_score ?? "0");
    const sc = sentScore > 0.15 ? "#34D399" : sentScore < -0.15 ? "#F87171" : "#9B9EA8";
    html += `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid #252836;">
      <tr>
        <td style="vertical-align:top;padding-right:10px;">
          <div style="color:#ECEDEF;font-size:13px;font-weight:600;line-height:1.4;margin-bottom:5px;">${item.title ?? ""}</div>
          <div style="color:#9B9EA8;font-size:11px;line-height:1.5;">${(item.summary ?? "").slice(0, 140)}${(item.summary ?? "").length > 140 ? "…" : ""}</div>
          <div style="margin-top:6px;display:flex;gap:8px;align-items:center;">
            ${sentBadge(sentLabel)}
            <span style="color:#6B7280;font-size:10px;">${item.source ?? ""}</span>
          </div>
        </td>
      </tr>
    </table>`;
  }
  return sectionCard("Market Intelligence — News", "◈", html, "#60A5FA");
}

function buildSignalsSection(signals: any[], title: string, emptyMsg: string): string {
  if (signals.length === 0) return sectionCard(title, "â—‰", `<div style="color:#6B7280;font-size:13px;">${emptyMsg}</div>`);
  let html = "";
  for (const s of signals) {
    const score = Number(s.analyst_score ?? 50);
    const bColor = score >= 70 ? "#34D399" : score >= 55 ? "#6366F1" : "#9B9EA8";
    const risks = (() => { try { return JSON.parse(s.risks ?? "[]"); } catch { return []; } })();
    const catalysts = (() => { try { return JSON.parse(s.catalysts ?? "[]"); } catch { return []; } })();
    html += `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:18px;padding-bottom:16px;border-bottom:1px solid #252836;">
      <tr><td>
        <div style="margin-bottom:6px;">
          <span style="color:#ECEDEF;font-size:16px;font-weight:700;margin-right:8px;">${s.symbol}</span>
          ${dirBadge(s.direction)}
          <span style="color:#6B7280;font-size:10px;margin-left:8px;">${s.agent_label ?? "agent"} &middot; ${s.is_holding ? "HOLDING" : "watchlist"}</span>
        </div>
        <div style="margin-bottom:8px;">${scoreBar(score, bColor)} <span style="color:${bColor};font-size:12px;font-weight:700;margin-left:8px;vertical-align:middle;">${score}/100</span></div>
        ${s.summary ? `<div style="color:#9B9EA8;font-size:12px;line-height:1.6;margin-bottom:6px;">${s.summary}</div>` : ""}
        ${risks.length > 0 ? `<div style="color:#F87171;font-size:11px;margin-top:4px;">âš  ${risks.slice(0, 2).join(" &middot; ")}</div>` : ""}
        ${catalysts.length > 0 ? `<div style="color:#34D399;font-size:11px;margin-top:3px;">â–² ${catalysts.slice(0, 2).join(" &middot; ")}</div>` : ""}
      </td></tr>
    </table>`;
  }
  return sectionCard(title, "â—‰", html);
}

function buildExitSection(signals: any[]): string {
  if (signals.length === 0) return sectionCard("Exit Watch — Held Stocks", "â—Ž", `<div style="color:#6B7280;font-size:13px;">No held stocks with deteriorating signals. All holdings look stable.</div>`, "#34D399");
  let html = `<div style="color:#F87171;font-size:11px;margin-bottom:12px;font-weight:600;">âš  Research agent flagged these Robinhood holdings for review</div>`;
  for (const s of signals) {
    const score = Number(s.analyst_score ?? 50);
    const risks = (() => { try { return JSON.parse(s.risks ?? "[]"); } catch { return []; } })();
    html += `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:12px;background:#1F0D0D;border:1px solid #F8717133;border-radius:8px;padding:12px 14px;">
      <tr>
        <td>
          <span style="color:#ECEDEF;font-size:14px;font-weight:700;">${s.symbol}</span>
          <span style="margin-left:8px;">${dirBadge(s.direction)}</span>
          <span style="color:#6B7280;font-size:10px;margin-left:8px;">score ${score}/100</span>
        </td>
      </tr>
      ${s.summary ? `<tr><td style="color:#9B9EA8;font-size:12px;padding-top:6px;">${s.summary}</td></tr>` : ""}
      ${risks.length > 0 ? `<tr><td style="color:#F87171;font-size:11px;padding-top:4px;">âš  ${risks.join(" &middot; ")}</td></tr>` : ""}
    </table>`;
  }
  return sectionCard("Exit Watch — Held Stocks", "â—Ž", html, "#F87171");
}

function buildRobinSection(snapshot: any): string {
  if (!snapshot) return sectionCard("Robinhood Account", "â—‡", `<div style="color:#6B7280;font-size:13px;">No snapshot data. Local sync script not yet running. Run the robin_stocks Python script on Windows to populate.</div>`);

  const equity = Number(snapshot.equity ?? 0);
  const portfolioValue = Number(snapshot.portfolio_value ?? equity);
  const buyingPower = Number(snapshot.buying_power ?? 0);
  const posCount = Number(snapshot.position_count ?? 0);
  const capturedAt = snapshot.captured_at ? new Date(snapshot.captured_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "unknown";

  const positions: any[] = Array.isArray(snapshot.positions_json) ? snapshot.positions_json : Object.values(snapshot.positions_json ?? {});
  const topPos = positions.slice(0, 5);

  let posHtml = "";
  if (topPos.length > 0) {
    posHtml = `<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;">
      <tr>
        <td style="color:#6B7280;font-size:10px;text-transform:uppercase;padding-bottom:6px;">Symbol</td>
        <td style="color:#6B7280;font-size:10px;text-transform:uppercase;padding-bottom:6px;">Qty</td>
        <td style="color:#6B7280;font-size:10px;text-transform:uppercase;padding-bottom:6px;">Avg Cost</td>
        <td style="color:#6B7280;font-size:10px;text-transform:uppercase;padding-bottom:6px;">Return</td>
      </tr>`;
    for (const p of topPos) {
      const sym = p.symbol ?? p.ticker ?? "?";
      const qty = parseFloat(p.quantity ?? p.shares ?? "0");
      const avgCost = parseFloat(p.average_buy_price ?? p.avg_cost ?? "0");
      const currentPrice = parseFloat(p.current_price ?? p.price ?? "0");
      const ret = avgCost > 0 && currentPrice > 0 ? ((currentPrice - avgCost) / avgCost) * 100 : null;
      const rc = ret != null ? pColor(ret) : "#9B9EA8";
      posHtml += `<tr>
        <td style="color:#ECEDEF;font-size:13px;font-weight:600;padding:4px 0;">${sym}</td>
        <td style="color:#9B9EA8;font-size:12px;padding:4px 0;">${qty.toFixed(qty % 1 === 0 ? 0 : 2)}</td>
        <td style="color:#9B9EA8;font-size:12px;padding:4px 0;">$${fmtNum(avgCost)}</td>
        <td style="color:${rc};font-size:12px;padding:4px 0;font-weight:600;">${ret != null ? fmtPct(ret) : "—"}</td>
      </tr>`;
    }
    posHtml += `</table>`;
  }

  const html = row2col(
    statBox("Total Equity", "$" + fmtNum(equity), "Portfolio value"),
    statBox("Buying Power", "$" + fmtNum(buyingPower), `${posCount} positions &middot; as of ${capturedAt}`)
  ) + posHtml;

  return sectionCard("Robinhood Account", "â—‡", html, "#60A5FA");
}

function buildPerformanceSection(
  paperNow: number, paperWeekAgo: number | null, paperMonthAgo: number | null,
  voo: { price: number; weekReturn: number | null; monthReturn: number | null } | null
): string {
  const w = paperWeekAgo != null && paperNow > 0 ? ((paperNow - paperWeekAgo) / paperWeekAgo) * 100 : null;
  const m = paperMonthAgo != null && paperNow > 0 ? ((paperNow - paperMonthAgo) / paperMonthAgo) * 100 : null;

  let html = `<table width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td style="color:#6B7280;font-size:10px;text-transform:uppercase;letter-spacing:0.07em;padding-bottom:8px;"></td>
      <td style="color:#6B7280;font-size:10px;text-transform:uppercase;letter-spacing:0.07em;padding-bottom:8px;">1 Week</td>
      <td style="color:#6B7280;font-size:10px;text-transform:uppercase;letter-spacing:0.07em;padding-bottom:8px;">1 Month</td>
    </tr>
    <tr>
      <td style="color:#6366F1;font-size:13px;font-weight:700;padding:4px 0;">Paper Portfolio</td>
      <td style="color:${w != null ? pColor(w) : "#9B9EA8"};font-size:14px;font-weight:700;padding:4px 0;">${w != null ? fmtPct(w) : "—"}</td>
      <td style="color:${m != null ? pColor(m) : "#9B9EA8"};font-size:14px;font-weight:700;padding:4px 0;">${m != null ? fmtPct(m) : "—"}</td>
    </tr>`;

  if (voo) {
    const wAlpha = w != null && voo.weekReturn != null ? w - voo.weekReturn : null;
    const mAlpha = m != null && voo.monthReturn != null ? m - voo.monthReturn : null;
    html += `<tr>
      <td style="color:#9B9EA8;font-size:13px;font-weight:600;padding:4px 0;">VOO (benchmark)</td>
      <td style="color:${voo.weekReturn != null ? pColor(voo.weekReturn) : "#9B9EA8"};font-size:14px;font-weight:700;padding:4px 0;">${voo.weekReturn != null ? fmtPct(voo.weekReturn) : "—"}</td>
      <td style="color:${voo.monthReturn != null ? pColor(voo.monthReturn) : "#9B9EA8"};font-size:14px;font-weight:700;padding:4px 0;">${voo.monthReturn != null ? fmtPct(voo.monthReturn) : "—"}</td>
    </tr>
    <tr>
      <td style="color:#9B9EA8;font-size:12px;font-style:italic;padding-top:8px;">Alpha vs VOO</td>
      <td style="color:${wAlpha != null ? pColor(wAlpha) : "#9B9EA8"};font-size:13px;font-weight:700;padding-top:8px;">${wAlpha != null ? fmtPct(wAlpha) : "—"}</td>
      <td style="color:${mAlpha != null ? pColor(mAlpha) : "#9B9EA8"};font-size:13px;font-weight:700;padding-top:8px;">${mAlpha != null ? fmtPct(mAlpha) : "—"}</td>
    </tr>`;
  }

  html += `</table>`;
  if (w == null && m == null) {
    html = `<div style="color:#6B7280;font-size:13px;">No historical NAV data yet. Performance tracking starts after first full week of paper trading.</div>`;
  }
  return sectionCard("Performance vs VOO", "â—Ž", html, "#6366F1");
}

function buildAgentStatusSection(agentCounts: any[], learnerRun: any): string {
  const agents = [
    { name: "deepseek-research", label: "DeepSeek Research", time: "12:00 UTC" },
    { name: "research",          label: "Research Agent",    time: "13:00 UTC" },
    { name: "paper-trader",      label: "Paper Trader",      time: "14:30 UTC" },
    { name: "position-monitor",  label: "Position Monitor",  time: "21:00 UTC" },
    { name: "learner",           label: "Learner Agent",     time: "Mondays 15:00 UTC" },
  ];

  const countMap: Record<string, { count: number; avg_score: number }> = {};
  for (const row of agentCounts ?? []) {
    countMap[row.agent_label] = { count: Number(row.count), avg_score: Number(row.avg_score ?? 0) };
  }

  let html = "";
  for (const a of agents) {
    const data = countMap[a.name];
    const ran = !!data;
    const dot = ran ? `<span style="color:#34D399;font-size:14px;">â—</span>` : `<span style="color:#252836;font-size:14px;">â—</span>`;
    const info = ran ? `${data.count} signals &middot; avg score ${data.avg_score.toFixed(0)}` : `Scheduled ${a.time}`;
    html += `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;">
      <tr>
        <td style="width:16px;vertical-align:middle;">${dot}</td>
        <td style="color:#ECEDEF;font-size:13px;font-weight:600;padding-left:8px;vertical-align:middle;">${a.label}</td>
        <td style="color:#6B7280;font-size:11px;text-align:right;vertical-align:middle;">${info}</td>
      </tr>
    </table>`;
  }

  if (learnerRun) {
    const lc = learnerRun.weights_changed ? "#34D399" : "#9B9EA8";
    html += `<div style="background:#1E1F3A;border-left:3px solid #6366F1;border-radius:0 6px 6px 0;padding:10px 14px;margin-top:10px;">
      <div style="color:#6366F1;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;">Learner Latest Finding</div>
      <div style="color:#9B9EA8;font-size:12px;line-height:1.6;">${(learnerRun.key_finding ?? "No finding recorded.").slice(0, 200)}</div>
      <div style="margin-top:6px;">${badge("Win Rate " + (Number(learnerRun.win_rate ?? 0) * 100).toFixed(0) + "%", "#6366F1")} ${badge(learnerRun.weights_changed ? "Weights Updated" : "No Weight Change", lc)}</div>
    </div>`;
  }

  return sectionCard("Agent Status Today", "â—†", html);
}

function buildMacroSection(macro: any): string {
  if (!macro) return sectionCard("Macro Context", "âŠ•", `<div style="color:#6B7280;font-size:13px;">No macro data. MacroSentinel runs on schedule.</div>`);
  const regimeColor = (macro.regime_label ?? "").toLowerCase().includes("bull") ? "#34D399" : (macro.regime_label ?? "").toLowerCase().includes("bear") ? "#F87171" : "#9B9EA8";
  const html = `
    <div style="margin-bottom:10px;">${badge(macro.regime_label ?? "Unknown", regimeColor)}</div>
    <div style="color:#9B9EA8;font-size:12px;line-height:1.65;">${macro.summary ?? "No summary."}</div>`;
  return sectionCard("Macro Regime", "âŠ•", html, regimeColor);
}

function buildEdgarInsidersSection(insiders: any[]): string {
  const buys = insiders.filter(r => r.payload?.transaction_type === "buy");
  const sells = insiders.filter(r => r.payload?.transaction_type === "sell");
  if (insiders.length === 0) {
    return sectionCard("SEC Form 4 — Insider Trades (7d)", "ðŸ›", `<div style="color:#6B7280;font-size:13px;">No notable insider transactions recorded in the last 7 days. EDGAR data populates when Smart Money → Form 4 tab is visited or after 14:00 UTC.</div>`, "#6366F1");
  }
  let html = `<div style="margin-bottom:10px;color:#9B9EA8;font-size:11px;">${buys.length} buy${buys.length !== 1 ? "s" : ""} &middot; ${sells.length} sell${sells.length !== 1 ? "s" : ""} &middot; Direct from SEC EDGAR Form 4 filings</div>`;
  for (const r of insiders.slice(0, 8)) {
    const p = r.payload ?? {};
    const isBuy = p.transaction_type === "buy";
    const tc = isBuy ? "#34D399" : "#F87171";
    const val = Number(p.value ?? 0);
    html += `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #252836;">
      <tr>
        <td><span style="font-size:13px;font-weight:700;color:#ECEDEF;">${r.symbol ?? "?"}</span>
          <span style="margin-left:6px;">${badge(isBuy ? "BUY â–²" : "SELL â–¼", tc)}</span>
          <span style="color:#6B7280;font-size:10px;margin-left:6px;">${p.shares?.toLocaleString() ?? "?"} sh @ $${Number(p.price ?? 0).toFixed(2)}</span>
        </td>
        <td align="right"><span style="color:${tc};font-size:13px;font-weight:700;">$${val >= 1_000_000 ? (val / 1_000_000).toFixed(1) + "M" : val >= 1000 ? (val / 1000).toFixed(0) + "k" : val.toFixed(0)}</span></td>
      </tr>
      <tr>
        <td colspan="2"><span style="color:#9B9EA8;font-size:11px;">${p.name ?? "Unknown"} · ${p.role ?? "Insider"} · Filed ${r.observed_at ? new Date(r.observed_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—"}</span></td>
      </tr>
    </table>`;
  }
  return sectionCard("SEC Form 4 — Insider Trades (7d)", "ðŸ›", html, "#6366F1");
}

function buildPendingProposalsSection(proposals: any[]): string {
  if (proposals.length === 0) return "";
  let html = `<div style="color:#FBBF24;font-size:11px;font-weight:700;margin-bottom:10px;">âš  ${proposals.length} trade proposal${proposals.length !== 1 ? "s" : ""} awaiting your approval — visit Smart Money to review</div>`;
  for (const p of proposals.slice(0, 4)) {
    html += `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;background:#1F1600;border:1px solid #FBBF2433;border-radius:6px;padding:10px 12px;">
      <tr>
        <td><span style="font-size:13px;font-weight:700;color:#ECEDEF;">${p.symbol}</span>
          <span style="margin-left:6px;">${badge((p.order_side ?? "buy").toUpperCase(), "#34D399")}</span>
          <span style="color:#9B9EA8;font-size:11px;margin-left:6px;">${p.qty} sh @ $${Number(p.limit_price ?? 0).toFixed(2)} · Score ${p.analyst_score}</span>
        </td>
        <td align="right"><span style="color:#6B7280;font-size:10px;">Expires ${p.approval_expires_at ? new Date(p.approval_expires_at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true }) : "—"}</span></td>
      </tr>
      ${p.rationale ? `<tr><td colspan="2" style="color:#9B9EA8;font-size:11px;padding-top:4px;">${(p.rationale ?? "").slice(0, 180)}</td></tr>` : ""}
    </table>`;
  }
  return sectionCard("âš¡ Trade Proposals — Needs Approval", "âš¡", html, "#FBBF24");
}

function buildLearnerWeightsSection(weights: any[]): string {
  if (!weights || weights.length === 0) return "";
  const row = weights[0];
  const dims = [
    { name: "Fundamental", key: "fundamental_weight" },
    { name: "Technical",   key: "technical_weight" },
    { name: "Sentiment",   key: "sentiment_weight" },
    { name: "Macro",       key: "macro_weight" },
    { name: "Insider",     key: "insider_weight" },
  ];
  let html = `<div style="color:#9B9EA8;font-size:11px;margin-bottom:10px;">Current Bayesian dimension weights used by ResearchAgent. LearnerAgent updates weekly after â‰¥10 closed trades.</div>`;
  html += `<table width="100%" cellpadding="0" cellspacing="0">`;
  for (const d of dims) {
    const w = Number(row[d.key] ?? 1.0);
    const changed = Math.abs(w - 1.0) > 0.02;
    const wColor = w > 1.1 ? "#34D399" : w < 0.9 ? "#F87171" : "#9B9EA8";
    const barFill = Math.round(Math.min(w / 1.5, 1) * 120);
    html += `<tr style="border-bottom:1px solid #25283633;">
      <td style="padding:6px 0;color:#ECEDEF;font-size:12px;font-weight:600;width:110px;">${d.name}</td>
      <td style="padding:6px 8px;">
        <table cellpadding="0" cellspacing="0" style="display:inline-table;vertical-align:middle;"><tr>
          <td width="${barFill}" style="height:4px;background:${wColor};border-radius:2px 0 0 2px;"></td>
          <td width="${120 - barFill}" style="height:4px;background:#252836;border-radius:0 2px 2px 0;"></td>
        </tr></table>
      </td>
      <td style="padding:6px 0;text-align:right;">
        <span style="color:${wColor};font-size:13px;font-weight:700;">${w.toFixed(2)}Ã—</span>
        ${changed ? `<span style="font-size:9px;color:${wColor};margin-left:3px;">${w > 1 ? "â–²" : "â–¼"}</span>` : ""}
      </td>
    </tr>`;
  }
  html += `</table>`;
  if (row.updated_at) {
    html += `<div style="color:#6B7280;font-size:10px;margin-top:8px;">Last updated: ${new Date(row.updated_at).toLocaleDateString("en-US", { month:"short", day:"numeric", year:"numeric" })}</div>`;
  }
  return sectionCard("Learner Agent — Dimension Weights", "ðŸ§ ", html, "#6366F1");
}

// Per-market champion dimension weights (NOT the vestigial global signal_weights
// row) — mirrors lib/champion-weights.ts / lib/research-agent.ts resolution so the
// newsletter shows the SAME weights scoring actually uses. Champion-first →
// static per-risk-profile baseline. Returns a { data: [row] } shape so the caller's
// existing `weights[0]` consumer is unchanged. Inlined because Deno edge functions
// can't import the app's lib/.
const PROFILE_WEIGHTS: Record<string, Record<string, number>> = {
  conservative: { fundamental: 0.4, technical: 0.2, sentiment: 0.15, macro: 0.15, insider: 0.1 },
  balanced: { fundamental: 0.3, technical: 0.25, sentiment: 0.2, macro: 0.15, insider: 0.1 },
  aggressive: { fundamental: 0.2, technical: 0.3, sentiment: 0.25, macro: 0.15, insider: 0.1 },
};

async function resolveChampionWeightsRow(supabase: any, market: string): Promise<{ data: any[] }> {
  let champion: any = null;
  const scoped = await supabase
    .from("strategy_versions")
    .select("version, weights_snapshot, promoted_at")
    .eq("is_champion", true)
    .eq("market", market)
    .order("promoted_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  // Fail closed to the static baseline. An unscoped champion fallback can cross
  // US/India books on any query error and is therefore forbidden.
  champion = scoped.error ? null : scoped.data;

  const { data: strategy } = await supabase
    .from("strategy_config")
    .select("risk_profile")
    .limit(1)
    .maybeSingle();
  const profileKey = (strategy?.risk_profile ?? "balanced") as string;
  const baseline = PROFILE_WEIGHTS[profileKey] ?? PROFILE_WEIGHTS.balanced;

  const snap = champion?.weights_snapshot ?? null;
  const cw = (short: string, full: string): number | undefined => {
    if (!snap) return undefined;
    const v = snap[short] ?? snap[full];
    return typeof v === "number" ? v : undefined;
  };

  const row = {
    fundamental_weight: cw("fundamental", "fundamental_weight") ?? baseline.fundamental,
    technical_weight: cw("technical", "technical_weight") ?? baseline.technical,
    sentiment_weight: cw("sentiment", "sentiment_weight") ?? baseline.sentiment,
    macro_weight: cw("macro", "macro_weight") ?? baseline.macro,
    insider_weight: cw("insider", "insider_weight") ?? baseline.insider,
    updated_at: snap ? (champion?.promoted_at ?? null) : null,
  };
  return { data: [row] };
}

function buildOpenPositionsSection(positions: any[]): string {
  if (positions.length === 0) {
    return sectionCard("Open Positions", "â—‰", `<div style="color:#6B7280;font-size:13px;">No open paper positions. Paper trader enters when signals score â‰¥65.</div>`);
  }
  let html = `<table width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td style="color:#6B7280;font-size:10px;text-transform:uppercase;padding-bottom:8px;">Symbol</td>
      <td style="color:#6B7280;font-size:10px;text-transform:uppercase;padding-bottom:8px;">Entry</td>
      <td style="color:#6B7280;font-size:10px;text-transform:uppercase;padding-bottom:8px;">Stop</td>
      <td style="color:#6B7280;font-size:10px;text-transform:uppercase;padding-bottom:8px;">Target</td>
      <td style="color:#6B7280;font-size:10px;text-transform:uppercase;padding-bottom:8px;">Score</td>
    </tr>`;
  for (const p of positions) {
    html += `<tr>
      <td style="color:#ECEDEF;font-size:13px;font-weight:600;padding:5px 0;">${p.symbol}</td>
      <td style="color:#9B9EA8;font-size:12px;padding:5px 0;">$${Number(p.entry_price).toFixed(2)}</td>
      <td style="color:#F87171;font-size:12px;padding:5px 0;">$${Number(p.stop_loss ?? 0).toFixed(2)}</td>
      <td style="color:#34D399;font-size:12px;padding:5px 0;">$${Number(p.take_profit ?? 0).toFixed(2)}</td>
      <td style="padding:5px 0;">${scoreBar(Number(p.entry_signal_score ?? 50), "#6366F1")}</td>
    </tr>`;
  }
  html += `</table>`;
  return sectionCard(`Open Positions (${positions.length})`, "â—‰", html);
}

function buildClosedTodaySection(trades: any[]): string {
  if (trades.length === 0) return sectionCard("Closed Today", "â—‰", `<div style="color:#6B7280;font-size:13px;">No trades closed today.</div>`);
  let totalPnl = 0;
  let html = "";
  for (const t of trades) {
    const pnl = Number(t.realized_pnl ?? 0);
    totalPnl += pnl;
    const pc = pColor(pnl);
    html += `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid #252836;">
      <tr>
        <td><span style="color:#ECEDEF;font-size:14px;font-weight:700;">${t.symbol}</span> <span style="color:#6B7280;font-size:11px;">${t.exit_reason ?? ""}</span></td>
        <td align="right"><span style="color:${pc};font-size:14px;font-weight:700;">${fmt$(pnl)}</span> <span style="color:${pc};font-size:11px;">${fmtPct(Number(t.realized_pnl_pct ?? 0))}</span></td>
      </tr>
      <tr>
        <td><span style="color:#6B7280;font-size:11px;">$${Number(t.entry_price ?? 0).toFixed(2)} &rarr; $${Number(t.exit_price ?? 0).toFixed(2)}</span></td>
        <td align="right">${badge(t.outcome === "win" ? "WIN" : "LOSS", t.outcome === "win" ? "#34D399" : "#F87171")}</td>
      </tr>
    </table>`;
  }
  html += `<div style="margin-top:8px;padding-top:8px;border-top:1px solid #6366F133;"><span style="color:#9B9EA8;font-size:12px;">Day P&amp;L: </span><span style="color:${pColor(totalPnl)};font-size:15px;font-weight:700;">${fmt$(totalPnl)}</span></div>`;
  return sectionCard(`Closed Today (${trades.length})`, "â—‰", html, pColor(totalPnl));
}

// â"€â"€â"€ Main â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

serve(async (req) => {
  const auth = req.headers.get("authorization") ?? "";
  if (!CRON_SECRET || !auth.includes(CRON_SECRET)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }

  const url = new URL(req.url);
  const edition = url.searchParams.get("edition") ?? "morning";

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { paused, reason } = await checkPaused(supabase);
  if (paused) return pausedResponse(reason);

  const resendKey = Deno.env.get("RESEND_API_KEY") ?? "";
  const avKey = Deno.env.get("ALPHA_VANTAGE_API_KEY") ?? "";
  if (!resendKey) {
    return new Response(JSON.stringify({ error: "Missing RESEND_API_KEY" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }

  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });
  const timeStr = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/New_York" });

  const todayStr = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const since48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const week7Ago = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const month30Ago = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // â"€â"€ Fetch all data in parallel â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [
    { data: portfolio },
    { data: allSignals },
    { data: openPositions },
    { data: macroData },
    { data: closedToday },
    { data: learnerRun },
    { data: watchlist },
    { data: prevPerf },
    { data: weekPerf },
    { data: monthPerf },
    { data: robinSnapshot },
    { data: agentCounts },
    { data: exitCandidates },
    { data: buyOpportunities },
    { data: edgarInsiders },
    { data: pendingProposals },
    { data: learnerPriors },
    marketNews,
    vooData,
  ] = await Promise.all([
    supabase.from("paper_portfolio").select("nav, updated_at").limit(1).single(),
    supabase.from("agent_signals").select("symbol,direction,analyst_score,summary,risks,catalysts,agent_label,is_holding,created_at").gte("created_at", since24h).order("analyst_score", { ascending: false }).limit(20),
    supabase.from("paper_trades").select("symbol,entry_price,quantity,stop_loss,take_profit,entry_signal_score,executed_at").is("outcome", null).order("executed_at", { ascending: false }),
    supabase.from("macro_regime").select("regime_label,summary,generated_at").order("generated_at", { ascending: false }).limit(1).single(),
    supabase.from("paper_trades").select("symbol,entry_price,exit_price,realized_pnl,realized_pnl_pct,outcome,exit_reason,exit_at").not("outcome", "is", null).gte("exit_at", todayStr),
    supabase.from("learner_runs").select("summary,key_finding,win_rate,weights_changed,run_started_at").order("run_started_at", { ascending: false }).limit(1).single(),
    supabase.from("watchlist").select("symbol").limit(20),
    supabase.from("paper_performance").select("nav").eq("date", yesterday).single(),
    supabase.from("paper_performance").select("nav").eq("date", week7Ago).single(),
    supabase.from("paper_performance").select("nav").eq("date", month30Ago).single(),
    supabase.from("live_account_snapshots").select("equity,buying_power,portfolio_value,position_count,positions_json,captured_at").eq("account_id", HOLDINGS_ACCOUNT).order("captured_at", { ascending: false }).limit(1).single(),
    supabase.rpc ? supabase.from("agent_signals").select("agent_label,analyst_score").gte("created_at", todayStr) : Promise.resolve({ data: [] }),
    supabase.from("agent_signals").select("symbol,direction,analyst_score,summary,risks,agent_label").eq("is_holding", true).gte("created_at", since48h).lte("analyst_score", 48).order("analyst_score", { ascending: true }).limit(5),
    supabase.from("agent_signals").select("symbol,direction,analyst_score,summary,risks,catalysts,agent_label").eq("is_holding", false).eq("direction", "long").gte("analyst_score", 72).gte("created_at", since48h).order("analyst_score", { ascending: false }).limit(4),
    supabase.from("evidence_records").select("symbol,payload,observed_at,retrieved_at").eq("evidence_type", "insider").eq("source", "sec_edgar").gte("retrieved_at", since7d).order("observed_at", { ascending: false }).limit(15),
    supabase.from("trade_proposals").select("id,symbol,order_side,qty,limit_price,analyst_score,rationale,approval_expires_at,created_at").eq("status", "pending_review").order("created_at", { ascending: false }).limit(5),
    // Champion dimension weights for the US book (this newsletter is US-only —
    // HOLDINGS_ACCOUNT is the US trading account); NOT the global signal_weights row.
    resolveChampionWeightsRow(supabase, "us"),
    fetchMarketNews(avKey),
    fetchVOOReturn(avKey),
  ]);

  // Aggregate agent counts manually (RPC might not exist)
  const countMap: Record<string, { count: number; avg_score: number }> = {};
  for (const s of agentCounts ?? []) {
    if (!countMap[s.agent_label]) countMap[s.agent_label] = { count: 0, avg_score: 0 };
    countMap[s.agent_label].count++;
    countMap[s.agent_label].avg_score += Number(s.analyst_score ?? 0);
  }
  for (const k of Object.keys(countMap)) {
    countMap[k].avg_score = countMap[k].avg_score / countMap[k].count;
  }
  const agentCountArray = Object.entries(countMap).map(([agent_label, v]) => ({ agent_label, ...v }));

  const nav = Number(portfolio?.nav ?? 10000);
  const prevNav = Number(prevPerf?.nav ?? 0);
  const navDelta = prevNav > 0 ? nav - prevNav : 0;
  const navDeltaPct = prevNav > 0 ? (navDelta / prevNav) * 100 : 0;
  const signalCount = (allSignals ?? []).length;
  const openCount = (openPositions ?? []).length;

  // Top signals (non-holding, long, high score) for morning
  const topSignals = (allSignals ?? []).filter(s => s.direction === "long" && Number(s.analyst_score) >= 60).slice(0, 4);

  // â"€â"€ Build email body by edition â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  let body = buildNavSection(nav, navDelta, navDeltaPct, openCount, signalCount);

  if (edition === "morning") {
    if ((pendingProposals ?? []).length > 0) body += buildPendingProposalsSection(pendingProposals ?? []);
    body += buildNewsSection(marketNews);
    body += buildSignalsSection(topSignals, "Top Signals — Act On These", "No qualifying long signals in last 24h. Agents run at 12:00 + 13:00 UTC.");
    body += buildExitSection(exitCandidates ?? []);
    body += buildSignalsSection(buyOpportunities ?? [], "Strong Buy Opportunities (Score â‰¥72)", "No high-conviction buys identified in last 48h.");
    body += buildOpenPositionsSection(openPositions ?? []);
    if ((edgarInsiders ?? []).length > 0) body += buildEdgarInsidersSection(edgarInsiders ?? []);
    body += buildMacroSection(macroData);
    body += buildLearnerWeightsSection(learnerPriors ?? []);
    body += buildAgentStatusSection(agentCountArray, learnerRun);
  }

  if (edition === "evening") {
    if ((pendingProposals ?? []).length > 0) body += buildPendingProposalsSection(pendingProposals ?? []);
    body += buildClosedTodaySection(closedToday ?? []);
    body += buildOpenPositionsSection(openPositions ?? []);
    body += buildPerformanceSection(nav, prevPerf?.nav ?? null, monthPerf?.nav ?? null, vooData);
    body += buildRobinSection(robinSnapshot);
    body += buildNewsSection(marketNews);
    body += buildSignalsSection(buyOpportunities ?? [], "Strong Buy Opportunities (Score â‰¥72)", "No high-conviction buys in last 48h.");
    body += buildExitSection(exitCandidates ?? []);
    body += buildSignalsSection((allSignals ?? []).slice(0, 5), "Today's Full Signal Digest", "No signals today.");
    if ((edgarInsiders ?? []).length > 0) body += buildEdgarInsidersSection(edgarInsiders ?? []);
    body += buildMacroSection(macroData);
    body += buildLearnerWeightsSection(learnerPriors ?? []);
    body += buildAgentStatusSection(agentCountArray, learnerRun);
  }

  const editionLabel = edition === "morning" ? "Morning Intelligence Brief" : "Evening Market Recap";
  const subject = edition === "morning" ? `â˜€ Kairos Morning Brief · ${dateStr}` : `â—' Kairos Evening Recap · ${dateStr}`;
  const html = wrapEmail(editionLabel, dateStr, timeStr, body);

  // â"€â"€ Send via Resend â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  let resendId: string | null = null;
  let sendError: string | null = null;

  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "Kairos <onboarding@resend.dev>", to: [RECIPIENT], subject, html }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await resp.json();
    if (resp.ok) resendId = j.id ?? null;
    else sendError = JSON.stringify(j);
  } catch (e: any) { sendError = e.message; }

  // â"€â"€ Save to newsletters table â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  const { data: saved } = await supabase.from("newsletters").insert({
    edition, subject, html_body: html,
    data_snapshot: { nav, navDelta, signalCount, openCount, edition, vooWeekReturn: vooData?.weekReturn ?? null },
    sent_to: RECIPIENT, resend_id: resendId, nav_at_send: nav,
    signals_count: signalCount, positions_count: openCount,
    sent_at: new Date().toISOString(),
  }).select("id").single();

  return new Response(JSON.stringify({
    ok: true, edition, subject, sentTo: RECIPIENT, resendId,
    savedId: (saved as any)?.id ?? null, error: sendError,
    stats: { signalCount, openCount, exitCandidates: (exitCandidates ?? []).length, buyOps: (buyOpportunities ?? []).length },
  }), { headers: { "Content-Type": "application/json" } });
});
