import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { callLLM } from "@/lib/llm-router";

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "vterminater@gmail.com";

async function getResendKey(svc: any): Promise<string> {
  try {
    const { data } = await svc.from("api_key_vault").select("key_value").eq("key_name", "RESEND_API_KEY").single();
    return (data as any)?.key_value ?? process.env.RESEND_API_KEY ?? "";
  } catch { return process.env.RESEND_API_KEY ?? ""; }
}

function mdToHtml(md: string): string {
  return md
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/^#{1,3} (.+)$/gm, "<h3 style='color:#ECEDEF;margin:16px 0 6px'>$1</h3>")
    .replace(/^  • (.+)$/gm, "<li style='margin:3px 0;color:#9B9EA8'>$1</li>")
    .replace(/^• (.+)$/gm, "<li style='margin:3px 0;color:#9B9EA8'>$1</li>")
    .replace(/\n\n/g, "</p><p style='margin:10px 0;color:#9B9EA8;line-height:1.6'>")
    .replace(/\n/g, "<br>");
}

interface BriefingData {
  session: "morning" | "evening";
  dateStr: string; dayName: string; timestamp: string;
  editorNote: string;
  paper: { nav: number; cash: number; pnl: number; pnlPct: number; positionsCount: number };
  live: { equity: number; buyingPower: number; positions: number } | null;
  healthScore: number; healthVerdict: string;
  market: { label: string; price: number | null; changePct: number | null }[];
  regime: { label: string; tone: string } | null;
  distribution: { strongBuy: number; buy: number; watch: number };
  positions: { symbol: string; direction: string; qty: number; entry: number; current: number | null; pnl: number | null; pnlPct: number | null }[];
  signals: { symbol: string; direction: string; score: number; reasoning: string }[];
  candidates: { symbol: string; direction: string; score: number; reasoning: string }[];
  earnings: { symbol: string; date: string; isToday: boolean; eps: number | null }[];
  learning: { symbol: string; outcome: string; note: string }[];
  phase: { closed: number; needed: number };
  researchRan: boolean;
}

function regimeTone(regime: string): string {
  const r = regime.toLowerCase();
  if (r.includes("risk-on") || r.includes("bull") || r.includes("green")) return "green";
  if (r.includes("risk-off") || r.includes("bear") || r.includes("red")) return "red";
  return "amber";
}

// ── Email palette (dark) ──
const E = { bg: "#0D0F14", card: "#1A1D27", surface: "#13151C", border: "#252836", text: "#ECEDEF", sub: "#9B9EA8", muted: "#6B7280", green: "#34D399", red: "#F87171", amber: "#FBBF24", accent: "#6366F1", blue: "#60A5FA" };
const pctColor = (v: number | null) => v == null ? E.muted : v >= 0 ? E.green : E.red;
const sign = (v: number) => (v >= 0 ? "+" : "");
function chip(text: string, color: string): string {
  return `<span style="display:inline-block;font-size:11px;font-weight:700;padding:3px 9px;border-radius:5px;background:${color}22;color:${color};border:1px solid ${color}44;margin:2px 4px 2px 0">${text}</span>`;
}
function bandHeader(label: string): string {
  return `<div style="font-size:11px;font-weight:800;letter-spacing:0.1em;color:${E.muted};text-transform:uppercase;margin:22px 0 10px;padding-bottom:6px;border-bottom:1px solid ${E.border}">${label}</div>`;
}

function buildBriefingHtml(d: BriefingData, baseUrl: string): { subject: string; html: string } {
  const icon = d.session === "morning" ? "📈" : "🌙";
  const label = d.session === "morning" ? "Morning Briefing" : "Evening Summary";
  const topSig = d.signals[0];

  const subject = d.session === "morning"
    ? `${icon} Your portfolio ${sign(d.paper.pnlPct)}${d.paper.pnlPct.toFixed(1)}%${topSig ? ` · Plus: ${topSig.direction.toUpperCase()} ${topSig.symbol} flagged` : " · pre-market scan"}`
    : `${icon} Close ${sign(d.paper.pnl)}$${Math.abs(d.paper.pnl).toFixed(0)} (${sign(d.paper.pnlPct)}${d.paper.pnlPct.toFixed(1)}%) · ${d.signals.length} signal${d.signals.length === 1 ? "" : "s"}`;

  const healthColor = d.healthVerdict === "Healthy" ? E.green : d.healthVerdict === "Watch" ? E.amber : E.red;

  // Market snapshot rows
  const marketRows = d.market.map(m => `
    <td style="padding:8px 6px;text-align:center;border:1px solid ${E.border};background:${E.surface}">
      <div style="font-size:10px;color:${E.muted};margin-bottom:3px">${m.label}</div>
      <div style="font-size:14px;font-weight:700;color:${E.text}">${m.price != null ? "$" + m.price.toFixed(0) : "—"}</div>
      <div style="font-size:11px;font-weight:600;color:${pctColor(m.changePct)}">${m.changePct != null ? sign(m.changePct) + m.changePct.toFixed(2) + "%" : "n/a"}</div>
    </td>`).join("");

  // Signal cards
  const signalCards = d.signals.length ? d.signals.map(s => {
    const sc = s.score >= 75 ? E.green : s.score >= 60 ? E.amber : E.blue;
    const why = s.reasoning ? s.reasoning.slice(0, 160) : "";
    return `<div style="background:${E.surface};border:1px solid ${E.border};border-left:3px solid ${sc};border-radius:8px;padding:12px 14px;margin-bottom:8px">
      <div style="font-size:13px;font-weight:700;color:${E.text}">${s.direction.toUpperCase()} ${s.symbol} ${chip(String(s.score) + "/100", sc)}</div>
      ${why ? `<div style="font-size:12px;color:${E.sub};line-height:1.55;margin-top:6px"><b style="color:${E.muted}">Why it matters:</b> ${why}</div>` : ""}
      <a href="${baseUrl}/dashboard/symbol/${s.symbol}" style="font-size:11px;color:${E.accent};text-decoration:none">Open ${s.symbol} »</a>
    </div>`;
  }).join("") : `<div style="font-size:13px;color:${E.muted};padding:8px 0">No agent signals yet — the pre-market research scan runs at 9:00 AM ET.</div>`;

  // Positions table
  const positionsBlock = d.positions.length ? `<table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse">
    ${d.positions.map(p => `<tr>
      <td style="padding:8px 10px;border-bottom:1px solid ${E.border};font-size:12px;font-weight:700;color:${E.text}">${p.symbol}</td>
      <td style="padding:8px 10px;border-bottom:1px solid ${E.border};font-size:12px;color:${E.sub}">${p.qty} @ $${p.entry.toFixed(2)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid ${E.border};font-size:12px;color:${E.text};text-align:right">${p.current != null ? "$" + p.current.toFixed(2) : "—"}</td>
      <td style="padding:8px 10px;border-bottom:1px solid ${E.border};font-size:12px;font-weight:700;text-align:right;color:${pctColor(p.pnlPct)}">${p.pnlPct != null ? sign(p.pnlPct) + p.pnlPct.toFixed(1) + "%" : "—"}</td>
    </tr>`).join("")}
  </table>` : `<div style="font-size:13px;color:${E.muted};padding:8px 0">No open positions.</div>`;

  const earningsBlock = d.earnings.length
    ? d.earnings.map(e => `${e.symbol}${e.isToday ? " <b style='color:" + E.amber + "'>(today)</b>" : " (" + e.date + ")"}${e.eps != null ? " · EPS est $" + e.eps.toFixed(2) : ""}`).join(" &nbsp;·&nbsp; ")
    : "None in the next 3 days for tracked symbols.";

  const learningBlock = d.learning.length
    ? d.learning.map(l => `<div style="font-size:12px;color:${E.sub};margin:3px 0">• ${l.symbol} <span style="color:${l.outcome === "win" ? E.green : l.outcome === "loss" ? E.red : E.muted}">[${l.outcome}]</span> ${l.note ?? ""}</div>`).join("")
    : `<div style="font-size:12px;color:${E.muted}">No closed trades yet.</div>`;

  const distBlock = (d.distribution.strongBuy + d.distribution.buy + d.distribution.watch) > 0
    ? `<div style="margin-bottom:10px">${d.distribution.strongBuy ? chip(`Strong Buy ${d.distribution.strongBuy}`, E.green) : ""}${d.distribution.buy ? chip(`Buy ${d.distribution.buy}`, E.amber) : ""}${d.distribution.watch ? chip(`Watch ${d.distribution.watch}`, E.blue) : ""}</div>`
    : "";

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:${E.bg};font-family:'Inter',Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:20px 14px">
  <div style="background:${E.card};border:1px solid ${E.border};border-radius:16px;overflow:hidden">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,${E.accent},#4F46E5);padding:20px 26px">
      <div style="font-size:10px;color:rgba(255,255,255,0.7);letter-spacing:0.18em;text-transform:uppercase">Kairos</div>
      <div style="font-size:20px;font-weight:700;color:#fff;margin-top:4px">${icon} ${label}</div>
      <div style="font-size:12px;color:rgba(255,255,255,0.85);margin-top:3px">${d.dayName}, ${d.dateStr} · as of ${d.timestamp}</div>
    </div>

    <div style="padding:20px 26px">

      <!-- Editor's note -->
      <div style="background:${E.surface};border:1px solid ${E.border};border-radius:10px;padding:14px 16px;font-size:13.5px;color:${E.text};line-height:1.6">${d.editorNote}</div>

      <!-- Health + P&L hero -->
      ${bandHeader("Portfolio Health")}
      <table width="100%" cellspacing="0" cellpadding="0"><tr>
        <td style="width:38%;vertical-align:middle">
          <div style="font-size:32px;font-weight:800;color:${healthColor};line-height:1">${d.healthScore.toFixed(1)}<span style="font-size:15px;color:${E.muted}">/5</span></div>
          <div style="margin-top:4px">${chip(d.healthVerdict, healthColor)}</div>
        </td>
        <td style="vertical-align:middle">
          <div style="font-size:11px;color:${E.muted}">Paper</div>
          <div style="font-size:15px;font-weight:700;color:${pctColor(d.paper.pnl)}">${sign(d.paper.pnl)}$${Math.abs(d.paper.pnl).toFixed(0)} <span style="font-size:12px">(${sign(d.paper.pnlPct)}${d.paper.pnlPct.toFixed(1)}%)</span></div>
          <div style="font-size:11px;color:${E.muted};margin-top:2px">NAV $${d.paper.nav.toFixed(0)} · ${d.paper.positionsCount} pos · cash $${d.paper.cash.toFixed(0)}</div>
          ${d.live ? `<div style="font-size:11px;color:${E.muted};margin-top:6px">Live ●●●●8641: $${d.live.equity.toFixed(0)} · ${d.live.positions} pos</div>` : ""}
        </td>
      </tr></table>

      <!-- Market snapshot -->
      ${bandHeader("Market Snapshot")}
      <table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse"><tr>${marketRows}</tr></table>
      ${d.regime ? `<div style="margin-top:10px">Regime: ${chip(d.regime.label, d.regime.tone === "green" ? E.green : d.regime.tone === "red" ? E.red : E.amber)}</div>` : ""}

      <!-- Agent signals -->
      ${bandHeader(d.session === "morning" ? "Agent Signals — Today's Candidates" : "Agent Signals — Fired Today")}
      ${distBlock}
      ${signalCards}

      <!-- Positions -->
      ${bandHeader("Your Positions")}
      ${positionsBlock}

      <!-- Earnings -->
      ${bandHeader("Upcoming Earnings")}
      <div style="font-size:12px;color:${E.sub};line-height:1.6">${earningsBlock}</div>

      <!-- Learning -->
      ${bandHeader("Learning")}
      ${learningBlock}
      <div style="margin-top:8px">${chip(`Phase 0 · ${d.phase.closed}/${d.phase.needed} trades to weight-tuning`, E.blue)}</div>

    </div>

    <!-- Footer -->
    <div style="padding:16px 26px;border-top:1px solid ${E.border};font-size:11px;color:${E.muted}">
      <a href="${baseUrl}/dashboard" style="color:${E.accent};text-decoration:none">Dashboard</a> ·
      <a href="${baseUrl}/dashboard/intelligence" style="color:${E.accent};text-decoration:none">Signals</a> ·
      <a href="${baseUrl}/dashboard/portfolio" style="color:${E.accent};text-decoration:none">Portfolio</a>
      <div style="margin-top:8px;color:${E.muted}">Kairos Agentic Quant Platform · paper + governed. Not financial advice.</div>
    </div>
  </div>
</div>
</body></html>`;

  return { subject, html };
}

async function sendBriefingEmail(svc: any, d: BriefingData): Promise<{ sent: boolean; error?: string }> {
  const resendKey = await getResendKey(svc);
  if (!resendKey) return { sent: false, error: "RESEND_API_KEY not configured" };

  const baseUrl = process.env.APP_BASE_URL ?? "http://localhost:3000";
  const { subject, html } = buildBriefingHtml(d, baseUrl);

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        // onboarding@resend.dev (Resend shared domain) only delivers to the Resend
        // account owner's own email. To send anywhere else, verify a domain at
        // resend.com/domains and set BRIEFING_FROM to an address on it.
        from: process.env.BRIEFING_FROM ?? "Kairos <onboarding@resend.dev>",
        // Recipient override — set BRIEFING_TO to test-deliver to the Resend
        // account's own address without changing ADMIN_EMAIL (used for vault OTP).
        to: [process.env.BRIEFING_TO ?? ADMIN_EMAIL],
        subject,
        html,
      }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.error(`[briefing-email] Resend ${res.status}: ${errBody}`);
      return { sent: false, error: `Resend ${res.status}: ${errBody.slice(0, 300)}` };
    }
    return { sent: true };
  } catch (e) {
    console.error("[briefing-email] fetch error:", e);
    return { sent: false, error: String(e) };
  }
}

export const dynamic = "force-dynamic";

async function fetchIndexClose(ticker: string, apiKey: string): Promise<{ price: number; changePct: number } | null> {
  try {
    const res = await fetch(
      `https://api.massive.com/v2/aggs/ticker/${ticker}/prev?adjusted=true&apiKey=${apiKey}`,
      { headers: { Accept: "application/json" }, next: { revalidate: 3600 } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const r = data.results?.[0];
    if (!r) return null;
    return { price: r.c, changePct: ((r.c - r.o) / r.o) * 100 };
  } catch { return null; }
}

export async function POST(req: NextRequest) {
  const cronSecret = req.headers.get("x-cron-secret");
  const isAuthed = req.headers.get("cookie")?.includes("sb-") ||
    cronSecret === process.env.CRON_SECRET;
  if (!isAuthed) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const forceSession: "morning" | "evening" | undefined = body.session;

  const svc = createServiceClient();
  const now = new Date();

  // Compute ET date (UTC-4 EDT / UTC-5 EST)
  const etOffset = -4;
  const etNow = new Date(now.getTime() + etOffset * 60 * 60 * 1000);
  const dateStr = etNow.toISOString().slice(0, 10);
  const dayName = etNow.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  const etH = etNow.getUTCHours();
  const session: "morning" | "evening" = forceSession ?? (etH < 14 ? "morning" : "evening");

  const massiveKey = process.env.MASSIVE_API_KEY;

  // Pull all context in parallel
  const [
    { data: lastRun },
    { data: portfolio },
    { data: rawPositions },
    { data: signals },
    { data: liveSnap },
    { data: tomorrowEarnings },
    { data: learningLog },
    { data: watchlist },
    spyData,
    qqqData,
    diaData,
    vixData,
    { data: macroRow },
    { count: closedTradesCount },
  ] = await Promise.all([
    svc.from("agent_runs").select("*").eq("agent_type", "research").order("created_at", { ascending: false }).limit(1).single(),
    svc.from("paper_portfolio").select("*").limit(1).single(),
    svc.from("paper_positions").select("*").eq("status", "open").limit(10),
    svc.from("agent_signals").select("symbol,direction,analyst_score,reasoning").eq("status", "pending").gte("analyst_score", 50).order("analyst_score", { ascending: false }).limit(8),
    svc.from("live_account_snapshots").select("*").order("captured_at", { ascending: false }).limit(1).single(),
    svc.from("earnings_calendar").select("symbol,report_date,estimate_eps,period").gte("report_date", dateStr).order("report_date").limit(5),
    svc.from("learning_log").select("symbol,outcome,note,created_at").order("created_at", { ascending: false }).limit(3),
    svc.from("watchlist").select("symbol,company_name").eq("research_enabled", true).limit(20),
    massiveKey ? fetchIndexClose("SPY", massiveKey) : Promise.resolve(null),
    massiveKey ? fetchIndexClose("QQQ", massiveKey) : Promise.resolve(null),
    massiveKey ? fetchIndexClose("DIA", massiveKey) : Promise.resolve(null),
    massiveKey ? fetchIndexClose("VIXY", massiveKey) : Promise.resolve(null),
    svc.from("macro_signals").select("regime, summary").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    svc.from("paper_trades").select("*", { count: "exact", head: true }).not("closed_at", "is", null),
  ]);

  // Enrich positions with current price from price_cache
  const positions = rawPositions ?? [];
  const positionLines: string[] = [];
  const positionsStruct: { symbol: string; direction: string; qty: number; entry: number; current: number | null; pnl: number | null; pnlPct: number | null }[] = [];
  for (const p of positions) {
    const { data: cache } = await svc
      .from("price_cache")
      .select("close")
      .eq("symbol", p.symbol)
      .order("date", { ascending: false })
      .limit(1)
      .single();
    const currentPrice = cache?.close ? Number(cache.close) : null;
    const entryPrice = Number(p.entry_price);
    if (currentPrice && entryPrice) {
      const pnlDollar = (currentPrice - entryPrice) * Number(p.quantity);
      const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;
      positionLines.push(
        `  • ${p.symbol} ${p.direction?.toUpperCase()}: ${p.quantity} shares @ $${entryPrice.toFixed(2)} entry → $${currentPrice.toFixed(2)} now = ${pnlDollar >= 0 ? "+" : ""}$${pnlDollar.toFixed(0)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)`
      );
      positionsStruct.push({ symbol: p.symbol, direction: p.direction ?? "long", qty: Number(p.quantity), entry: entryPrice, current: currentPrice, pnl: pnlDollar, pnlPct });
    } else {
      positionLines.push(`  • ${p.symbol} ${p.direction?.toUpperCase()}: ${p.quantity} shares @ $${entryPrice.toFixed(2)} entry (price unavailable)`);
      positionsStruct.push({ symbol: p.symbol, direction: p.direction ?? "long", qty: Number(p.quantity), entry: entryPrice, current: null, pnl: null, pnlPct: null });
    }
  }

  // Market context block
  const fmt = (d: { price: number; changePct: number } | null, label: string) =>
    d ? `${label}: $${d.price.toFixed(0)} (${d.changePct >= 0 ? "+" : ""}${d.changePct.toFixed(2)}%)` : `${label}: unavailable`;

  const marketBlock = [
    fmt(spyData, "S&P 500 (SPY)"),
    fmt(qqqData, "Nasdaq (QQQ)"),
    fmt(diaData, "Dow (DIA)"),
  ].join(" | ");

  // /prev returns the PREVIOUS completed session close — label accordingly
  const marketLabel = session === "morning"
    ? "YESTERDAY'S CLOSE (prior session — /prev data, pre-market context)"
    : "MOST RECENT CLOSE (prior session via /prev — today's final data may lag by ~15 min)";

  // Portfolio block
  const nav = portfolio?.nav ?? 10000;
  const cash = portfolio?.cash_balance ?? 10000;
  const pnl = nav - 10000;
  const pnlPct = (pnl / 10000) * 100;

  const portfolioBlock = `NAV: $${nav.toFixed(0)} | Cash: $${cash.toFixed(0)} | Total P&L: ${pnl >= 0 ? "+" : ""}$${Math.abs(pnl).toFixed(0)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%) | ${positions.length} open positions`;

  // Signal block with reasoning
  const signalLines = (signals ?? []).map((s: any) => {
    const reasoning = s.reasoning ? ` — ${String(s.reasoning).slice(0, 120)}` : "";
    return `  • ${s.symbol} ${s.direction?.toUpperCase()} (score ${s.analyst_score})${reasoning}`;
  });

  // Earnings block
  const earningsLines = (tomorrowEarnings ?? []).map((e: any) =>
    `  • ${e.symbol}${e.report_date === dateStr ? " (TODAY)" : ` (${e.report_date})`}${e.estimate_eps != null ? ` — EPS est. $${Number(e.estimate_eps).toFixed(2)}` : ""}`
  );

  // Learning block
  const learningLines = (learningLog ?? []).length > 0
    ? (learningLog ?? []).map((l: any) => `  • ${l.symbol} [${l.outcome}]: ${l.note}`)
    : ["  • No closed trades yet (Phase 0 — learning starts after 10+ closed paper trades)"];

  // Live account block
  const liveBlock = liveSnap
    ? `Equity: $${Number(liveSnap.equity).toFixed(2)} | Buying power: $${Number(liveSnap.buying_power).toFixed(2)} | Positions: ${liveSnap.position_count} | Synced: ${new Date(liveSnap.captured_at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}`
    : "Not synced";

  // Research run block
  const researchBlock = lastRun
    ? `Last run: ${new Date(lastRun.created_at).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} — symbols: ${Array.isArray(lastRun.symbols) ? lastRun.symbols.join(", ") : "watchlist"} — ${lastRun.signals_written ?? 0} signals written`
    : "No research run yet today";

  // Watchlist
  const watchlistSymbols = (watchlist ?? []).map((w: any) => w.symbol).join(", ");

  const sessionLabel = session === "morning" ? "Morning Briefing (pre-market)" : "Evening Summary (post-market close)";

  const contextBlock = `
=== REAL DATA CONTEXT — DO NOT INVENT ANYTHING NOT IN THIS BLOCK ===

DATE: ${dayName}, ${dateStr}
SESSION: ${sessionLabel}

${marketLabel}:
${marketBlock}

PAPER PORTFOLIO:
${portfolioBlock}

OPEN PAPER POSITIONS:
${positionLines.length > 0 ? positionLines.join("\n") : "  • No open positions"}

LIVE ROBINHOOD ACCOUNT (••••8641, read-only):
${liveBlock}

AGENT SIGNALS (pending, score ≥50):
${signalLines.length > 0 ? signalLines.join("\n") : "  • No signals yet — research hasn't run today"}

RESEARCH RUN STATUS:
${researchBlock}

UPCOMING EARNINGS:
${earningsLines.length > 0 ? earningsLines.join("\n") : "  • None in the next 3 days for tracked symbols"}

LEARNING LOG (recent closed trades):
${learningLines.join("\n")}

WATCHLIST (research-enabled): ${watchlistSymbols || "empty"}

=== END CONTEXT ===
`.trim();

  // The rich data (market table, portfolio cards, signals, movers) is rendered
  // deterministically as HTML blocks below. The LLM writes ONLY a short editor's
  // note — the human voice/takeaway — so we never regurgitate numbers as prose.
  const morningPrompt = `You are the editor of a personal markets briefing. Below is today's real data.

${contextBlock}

Write a SHORT "What matters today" note: 2-3 sentences max, ~45 words. Forward-looking, present/future tense, second person. Point to the single most important thing to watch or do today based on the actual signals/earnings/positions above. If nothing is actionable (no signals, no positions), say plainly what today is for (e.g. "a clean slate — let the pre-market scan run"). Use ONLY the data above. No headings, no bullet points, no disclaimers, no invented events. Just the note.`;

  const eveningPrompt = `You are the editor of a personal markets briefing. Below is today's real data.

${contextBlock}

Write a SHORT "Today's takeaway" note: 2-3 sentences max, ~45 words. Retrospective, past tense for today. Second person. Capture the one thing that mattered today from the actual index closes / position P&L / signals above, and what it sets up for tomorrow. Use ONLY the data above — do not say "markets were mixed" unless the index data supports it. No headings, no bullets, no disclaimers, no invented events. Just the note.`;

  const result = await callLLM({
    task: "summarize",
    prompt: session === "morning" ? morningPrompt : eveningPrompt,
    maxTokens: 150,
  });
  const editorNote = result.text.trim();
  const content = editorNote; // in-app briefing shows the editor's note

  await svc.from("briefings").upsert(
    { date: dateStr, session, content, model: "auto" },
    { onConflict: "date,session" }
  );

  // ── Derived blocks for the rich email (rendered deterministically) ──────────
  const market = [
    { label: "S&P 500", price: spyData?.price ?? null, changePct: spyData?.changePct ?? null },
    { label: "Nasdaq",  price: qqqData?.price ?? null, changePct: qqqData?.changePct ?? null },
    { label: "Dow",     price: diaData?.price ?? null, changePct: diaData?.changePct ?? null },
    { label: "VIX (VIXY)", price: vixData?.price ?? null, changePct: vixData?.changePct ?? null },
  ];

  const regimeRaw = (macroRow as any)?.regime ?? null;
  const regime = regimeRaw ? { label: String(regimeRaw), tone: regimeTone(String(regimeRaw)) } : null;

  const pendingSignals: { symbol: string; direction: string; score: number; reasoning: string }[] = (signals ?? []).map((s: any) => ({ symbol: s.symbol, direction: s.direction ?? "long", score: Number(s.analyst_score), reasoning: s.reasoning ? String(s.reasoning) : "" }));
  const distribution = {
    strongBuy: pendingSignals.filter(s => s.score >= 75).length,
    buy:       pendingSignals.filter(s => s.score >= 60 && s.score < 75).length,
    watch:     pendingSignals.filter(s => s.score >= 50 && s.score < 60).length,
  };

  // Health score (0-5): neutral 3.0, nudged by P&L and average signal strength.
  const avgScore = pendingSignals.length ? pendingSignals.reduce((a, s) => a + s.score, 0) / pendingSignals.length : 50;
  const healthScore = Math.max(0, Math.min(5, 3.0 + (pnlPct * 0.1) + (avgScore - 50) / 30));
  const healthVerdict = healthScore >= 4 ? "Healthy" : healthScore >= 3 ? "Watch" : "Exposed";

  const briefingData: BriefingData = {
    session, dateStr, dayName,
    timestamp: etNow.toISOString().slice(11, 16) + " ET",
    editorNote,
    paper: { nav, cash, pnl, pnlPct, positionsCount: positions.length },
    live: liveSnap ? { equity: Number(liveSnap.equity), buyingPower: Number(liveSnap.buying_power), positions: liveSnap.position_count ?? 0 } : null,
    healthScore: Number(healthScore.toFixed(1)), healthVerdict,
    market, regime, distribution,
    positions: positionsStruct,
    signals: pendingSignals.slice(0, 5),
    candidates: pendingSignals.slice(0, 3),
    earnings: (tomorrowEarnings ?? []).map((e: any) => ({ symbol: e.symbol, date: e.report_date, isToday: e.report_date === dateStr, eps: e.estimate_eps != null ? Number(e.estimate_eps) : null })),
    learning: (learningLog ?? []).map((l: any) => ({ symbol: l.symbol, outcome: l.outcome, note: l.note })),
    phase: { closed: closedTradesCount ?? 0, needed: 10 },
    researchRan: !!lastRun && new Date(lastRun.created_at).toISOString().slice(0, 10) === dateStr,
  };

  // Send email — briefing IS the email, so await and report the real result.
  const emailResult = await sendBriefingEmail(svc, briefingData);

  // Only stamp email_sent_at when the send actually succeeded.
  if (emailResult.sent) {
    await svc.from("briefings")
      .update({ email_sent_at: new Date().toISOString() })
      .eq("date", dateStr)
      .eq("session", session);
  }

  return NextResponse.json({
    session, date: dateStr, content,
    email_sent: emailResult.sent,
    email_error: emailResult.error,
  });
}
