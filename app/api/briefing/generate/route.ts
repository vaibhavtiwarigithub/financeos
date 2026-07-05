import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { createClient } from "@/lib/supabase/server";
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
  recap7d?: { agent: string; runs: number; signals: number; today: number }[];
  learnerHypCount?: number;
  mentor?: { grade: number | null; focus: string[]; lesson: string | null; milestone: string | null } | null;
  outlook?: { market: string | null; positions: string | null; future: string | null } | null;
}

function regimeTone(regime: string): string {
  const r = regime.toLowerCase();
  if (r.includes("risk-on") || r.includes("bull") || r.includes("green")) return "green";
  if (r.includes("risk-off") || r.includes("bear") || r.includes("red")) return "red";
  return "amber";
}

// ── Email palette (light — user wants a not-all-dark briefing) ──
const E = { bg: "#F5F6F8", card: "#FFFFFF", surface: "#F1F3F6", border: "#E3E6EA", text: "#1A1D27", sub: "#4B5563", muted: "#6B7280", green: "#16A34A", red: "#DC2626", amber: "#D97706", accent: "#4F46E5", blue: "#2563EB" };
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
      <div style="font-size:11px;color:${E.muted};margin-top:8px;line-height:1.5">What this is: a 0–5 read of your book — it blends realized P&L momentum with how strong the agent's current signals are. Higher = a more constructive setup, not a guarantee. Verdict: Healthy ≥4, Watch ≥3, Exposed below.</div>

      <!-- Market snapshot -->
      ${bandHeader("Market Snapshot")}
      <table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse"><tr>${marketRows}</tr></table>
      ${d.regime ? `<div style="margin-top:10px">Regime: ${chip(d.regime.label, d.regime.tone === "green" ? E.green : d.regime.tone === "red" ? E.red : E.amber)}</div>` : ""}
      <div style="font-size:11px;color:${E.muted};margin-top:6px;line-height:1.5">How to read it: green across the indices = risk-on tape; VIX rising = fear building; the Regime chip is the one-word summary the agents act on.</div>

      <!-- Outlook (AI, grounded, with confidence) -->
      ${d.outlook && (d.outlook.market || d.outlook.positions || d.outlook.future) ? `${bandHeader("Outlook")}
      ${d.outlook.market ? `<div style="font-size:12.5px;color:${E.sub};line-height:1.6;margin-bottom:6px"><b style="color:${E.text}">Market:</b> ${d.outlook.market}</div>` : ""}
      ${d.outlook.positions ? `<div style="font-size:12.5px;color:${E.sub};line-height:1.6;margin-bottom:6px"><b style="color:${E.text}">Positions:</b> ${d.outlook.positions}</div>` : ""}
      ${d.outlook.future ? `<div style="font-size:12.5px;color:${E.sub};line-height:1.6"><b style="color:${E.text}">Next 1–2 weeks:</b> ${d.outlook.future}</div>` : ""}` : ""}

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

      <!-- 7-day agent recap -->
      ${bandHeader("What the agents did — last 7 days")}
      ${d.recap7d && d.recap7d.length ? d.recap7d.map(r => `<div style="font-size:12px;color:${E.sub};margin:2px 0">• <b style="color:${E.text}">${r.agent}</b>: ${r.runs} run${r.runs === 1 ? "" : "s"} (${r.today} today), ${r.signals} signals written</div>`).join("") : `<div style="font-size:12px;color:${E.muted}">No agent runs in the last 7 days.</div>`}
      <div style="font-size:11px;color:${E.muted};margin-top:6px">LearnerAgent hypotheses this cycle: ${d.learnerHypCount ?? 0}. This recap shows what ran today vs across the week so you can see the pipeline working.</div>

      <!-- Mentor -->
      ${d.mentor ? `${bandHeader("Your Coach")}
      <div style="background:${E.surface};border:1px solid ${E.border};border-radius:10px;padding:12px 14px">
        ${d.mentor.grade != null ? `<div style="font-size:12px;color:${E.muted};margin-bottom:6px">Discipline &amp; progress grade: <b style="color:${E.text}">${d.mentor.grade}/100</b></div>` : ""}
        ${d.mentor.lesson ? `<div style="font-size:12.5px;color:${E.sub};line-height:1.6"><b style="color:${E.accent}">Lesson:</b> ${d.mentor.lesson}</div>` : ""}
        ${Array.isArray(d.mentor.focus) && d.mentor.focus.length ? `<div style="font-size:12px;color:${E.sub};margin-top:6px"><b style="color:${E.text}">Focus:</b> ${d.mentor.focus.slice(0,2).join("; ")}</div>` : ""}
        ${d.mentor.milestone ? `<div style="font-size:12px;color:${E.sub};margin-top:6px"><b style="color:${E.text}">Next milestone:</b> ${d.mentor.milestone}</div>` : ""}
      </div>` : ""}

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
    const resendJson = await res.json().catch(() => ({}));

    // Record the send into `newsletters` — this is the table the Intelligence
    // page's Newsletter history tab actually reads. It was always empty
    // because nothing wrote to it; the working email path (this function)
    // only wrote to `briefings`. Best-effort — a logging failure shouldn't
    // fail the email send itself.
    try {
      await svc.from("newsletters").insert({
        edition: d.session,
        subject,
        html_body: html,
        data_snapshot: d,
        sent_to: process.env.BRIEFING_TO ?? ADMIN_EMAIL,
        resend_id: resendJson?.id ?? null,
        nav_at_send: d.paper.nav,
        signals_count: d.signals.length,
        positions_count: d.positions.length,
      });
    } catch (e) {
      console.error("[briefing-email] newsletters insert failed:", e);
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
  // Proper auth — NEVER infer from a cookie substring (that let any cookie
  // containing "sb-" through). Cron via secret; users via a real session.
  const cronSecret = req.headers.get("x-cron-secret");
  const isCron = cronSecret && cronSecret === process.env.CRON_SECRET;
  if (!isCron) {
    const userClient = await createClient();
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  // Validate session: only morning|evening (or undefined = auto). Reject others
  // so a bogus value can't create a new briefings.session and bypass idempotency.
  const rawSession = body.session;
  if (rawSession != null && rawSession !== "morning" && rawSession !== "evening") {
    return NextResponse.json({ error: "session must be 'morning' or 'evening'" }, { status: 400 });
  }
  const forceSession: "morning" | "evening" | undefined = rawSession ?? undefined;

  const svc = createServiceClient();
  const now = new Date();

  // Compute ET wall-clock via the timezone DB (handles EDT/EST DST automatically),
  // not a fixed -4 offset which is wrong for half the year.
  const etNow = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const dateStr = `${etNow.getFullYear()}-${String(etNow.getMonth() + 1).padStart(2, "0")}-${String(etNow.getDate()).padStart(2, "0")}`;
  const dayName = etNow.toLocaleDateString("en-US", { weekday: "long" });
  const etH = etNow.getHours();
  const session: "morning" | "evening" = forceSession ?? (etH < 14 ? "morning" : "evening");
  const etDay = etNow.getDay(); // 0 = Sunday, 6 = Saturday
  const isWeekend = etDay === 0 || etDay === 6;

  const massiveKey = process.env.MASSIVE_API_KEY;
  const since7dISO = new Date(now.getTime() - 7 * 86400_000).toISOString();

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
    { data: recentRuns },
    { data: learnerRuns },
    { data: mentorRow },
    { data: weekTrades },
  ] = await Promise.all([
    svc.from("agent_runs").select("*").eq("agent_type", "research").order("created_at", { ascending: false }).limit(1).single(),
    // Phase 4: US pool only (post-057 there's also an India ₹ row). maybeSingle so a missing market column pre-057 yields null gracefully.
    svc.from("paper_portfolio").select("*").eq("market", "us").limit(1).maybeSingle(),
    svc.from("paper_positions").select("*").limit(10),
    svc.from("agent_signals").select("symbol,direction,analyst_score,reasoning").eq("status", "pending").gte("analyst_score", 50).order("analyst_score", { ascending: false }).limit(8),
    // Filter to the Trading account (••••8641) — see app/dashboard/page.tsx
    // for why: without this, the most-recent-snapshot query could silently
    // return a different account's row.
    svc.from("live_account_snapshots").select("*").eq("account_id", "965848641").order("captured_at", { ascending: false }).limit(1).single(),
    svc.from("earnings_calendar").select("symbol,report_date,estimate_eps,period").gte("report_date", dateStr).order("report_date").limit(5),
    // learning_log has no symbol/outcome columns (it's the learner's own
    // weight-mutation audit log) — recently closed trades actually live in
    // paper_trades (which does have symbol/outcome/closed_at).
    svc.from("paper_trades").select("symbol,outcome,rationale,closed_at").not("closed_at", "is", null).order("closed_at", { ascending: false }).limit(3),
    svc.from("watchlist").select("symbol,company_name").eq("research_enabled", true).limit(20),
    massiveKey ? fetchIndexClose("SPY", massiveKey) : Promise.resolve(null),
    massiveKey ? fetchIndexClose("QQQ", massiveKey) : Promise.resolve(null),
    massiveKey ? fetchIndexClose("DIA", massiveKey) : Promise.resolve(null),
    massiveKey ? fetchIndexClose("VIXY", massiveKey) : Promise.resolve(null),
    svc.from("macro_signals").select("regime, summary").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    svc.from("paper_trades").select("*", { count: "exact", head: true }).not("closed_at", "is", null),
    svc.from("agent_runs").select("agent_type, signals_written, started_at, trigger_source").gte("started_at", since7dISO).order("started_at", { ascending: false }).limit(200),
    svc.from("learner_runs").select("run_date, hypotheses").gte("run_date", dateStr.slice(0, 8) + "01").order("run_date", { ascending: false }).limit(4),
    svc.from("mentor_insights").select("grade, focus_areas, lesson, next_milestone").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    svc.from("paper_trades").select("symbol, side, pnl, closed_at").gte("executed_at", since7dISO).not("closed_at", "is", null).order("closed_at", { ascending: false }).limit(20),
  ]);

  // 7-day agent-activity recap (used in context block + weekend prompt + email)
  const recapByAgent: Record<string, { runs: number; signals: number; today: number }> = {};
  for (const r of (recentRuns ?? []) as any[]) {
    const k = r.agent_type ?? "agent";
    recapByAgent[k] ??= { runs: 0, signals: 0, today: 0 };
    recapByAgent[k].runs++;
    recapByAgent[k].signals += r.signals_written ?? 0;
    if (new Date(r.started_at).toISOString().slice(0, 10) === dateStr) recapByAgent[k].today++;
  }
  const recap7d = Object.entries(recapByAgent).map(([agent, v]) => ({ agent, ...v }));
  const learnerHypotheses = ((learnerRuns ?? [])[0] as any)?.hypotheses;
  const hypCount = Array.isArray(learnerHypotheses) ? learnerHypotheses.length : 0;
  const mentorBlockData = mentorRow ? { grade: (mentorRow as any).grade, focus: (mentorRow as any).focus_areas, lesson: (mentorRow as any).lesson, milestone: (mentorRow as any).next_milestone } : null;
  const weekTradesArr = (weekTrades ?? []) as any[];
  const weekPnl = weekTradesArr.reduce((sum, t) => sum + (Number(t.pnl) || 0), 0);
  const weekWins = weekTradesArr.filter(t => Number(t.pnl) > 0).length;

  const recapLines = recap7d.length
    ? recap7d.map(r => `  • ${r.agent}: ${r.runs} run${r.runs === 1 ? "" : "s"} in the last 7 days (${r.today} today), ${r.signals} signals written`)
    : ["  • No agent runs in the last 7 days"];
  const mentorLine = mentorBlockData
    ? `Grade: ${mentorBlockData.grade ?? "n/a"}/100. Lesson: ${mentorBlockData.lesson ?? "none yet"}. Focus: ${(mentorBlockData.focus ?? []).slice(0, 2).join("; ") || "none"}. Next milestone: ${mentorBlockData.milestone ?? "none"}`
    : "No mentor evaluation yet";
  const weekTradesLine = weekTradesArr.length
    ? `${weekTradesArr.length} closed in last 7 days, ${weekWins} wins, net ${weekPnl >= 0 ? "+" : ""}$${weekPnl.toFixed(0)}`
    : "No paper trades closed in the last 7 days";

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
    // paper_positions columns: qty, avg_cost, current_price (no status/direction/
    // entry_price/quantity — it's long-only, and open = present). Prefer the row's
    // current_price, fall back to price_cache.
    const currentPrice = (p.current_price ? Number(p.current_price) : null) ?? (cache?.close ? Number(cache.close) : null);
    const entryPrice = Number(p.avg_cost);
    const qty = Number(p.qty);
    if (currentPrice && Number.isFinite(entryPrice) && entryPrice > 0) {
      const pnlDollar = (currentPrice - entryPrice) * qty;
      const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;
      positionLines.push(
        `  • ${p.symbol} LONG: ${qty} shares @ $${entryPrice.toFixed(2)} entry → $${currentPrice.toFixed(2)} now = ${pnlDollar >= 0 ? "+" : ""}$${pnlDollar.toFixed(0)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)`
      );
      positionsStruct.push({ symbol: p.symbol, direction: "long", qty, entry: entryPrice, current: currentPrice, pnl: pnlDollar, pnlPct });
    } else {
      positionLines.push(`  • ${p.symbol} LONG: ${qty} shares @ $${Number.isFinite(entryPrice) ? entryPrice.toFixed(2) : "?"} entry (price unavailable)`);
      positionsStruct.push({ symbol: p.symbol, direction: "long", qty, entry: entryPrice, current: null, pnl: null, pnlPct: null });
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
    ? (learningLog ?? []).map((l: any) => `  • ${l.symbol} [${l.outcome}]: ${l.rationale ?? ""}`)
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

MARKET REGIME (from macro signals): ${(macroRow as any)?.regime ?? "unavailable"} — ${(macroRow as any)?.summary ?? ""}

LAST 7 DAYS — AGENT ACTIVITY:
${recapLines.join("\n")}

LAST 7 DAYS — PAPER TRADES CLOSED: ${weekTradesLine}

MENTOR PROGRESS: ${mentorLine}

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

  // Weekends: markets are closed and there's rarely anything "actionable today",
  // so instead of a bland "nothing to do" note, give a real weekly recap +
  // week-ahead outlook — this is the main thing checked when opening the app,
  // it should never read as empty.
  const weekendPrompt = `You are the editor of a personal markets briefing, writing the weekend edition. Below is the real account/agent/market data.

${contextBlock}

Write TWO short paragraphs (second person, ~60-90 words total, no headings, no bullets, no disclaimers, no invented events — use ONLY the data above):
1. "Last 7 days": what actually happened — paper P&L, live account state, agent runs/signals written, any closed trades and their outcomes, mentor progress if graded.
2. "Next 7 days": what to expect and prepare for — the market regime read, upcoming earnings, watchlist candidates, and what the agents will be doing while markets are closed (research/learning continues on a weekly cycle even though trading doesn't).
If a category above has no data (e.g. no agent runs, no mentor grade), say so plainly rather than skipping it silently — the point is an honest, complete picture, not padding.`;

  const result = await callLLM({
    task: "summarize",
    prompt: isWeekend ? weekendPrompt : (session === "morning" ? morningPrompt : eveningPrompt),
    maxTokens: isWeekend ? 320 : 150,
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
    learning: (learningLog ?? []).map((l: any) => ({ symbol: l.symbol, outcome: l.outcome, note: l.rationale ?? "" })),
    phase: { closed: closedTradesCount ?? 0, needed: 10 },
    researchRan: !!lastRun && new Date(lastRun.created_at).toISOString().slice(0, 10) === dateStr,
  };

  // 7-day agent recap / mentor block already computed above (before contextBlock)
  (briefingData as any).recap7d = recap7d;
  (briefingData as any).learnerHypCount = hypCount;
  (briefingData as any).mentor = mentorBlockData;

  // AI outlooks with confidence — one grounded call over the real data.
  try {
    const outlookPrompt = `You are a markets analyst. Using ONLY this data, write THREE short outlooks, each 1-2 sentences, each ending with a confidence in parentheses (Low/Medium/High + one reason).

${contextBlock}

Format EXACTLY (no extra text):
MARKET: <near-term market outlook> (Confidence: <Low|Medium|High> — <reason>)
POSITIONS: <outlook for the held positions, or 'No open positions to assess.'> (Confidence: ...)
FUTURE: <what to expect next 1-2 weeks and what would change it> (Confidence: ...)

No invented events. Ground every claim in the data above.`;
    const ol = await callLLM({ task: "summarize", model: "deepseek-chat", prompt: outlookPrompt, maxTokens: 300 });
    const t = ol.text;
    const grab = (k: string) => { const m = t.match(new RegExp(k + ":\\s*([\\s\\S]*?)(?=\\n(?:MARKET|POSITIONS|FUTURE):|$)", "i")); return m ? m[1].trim() : null; };
    (briefingData as any).outlook = { market: grab("MARKET"), positions: grab("POSITIONS"), future: grab("FUTURE") };
  } catch { (briefingData as any).outlook = null; }

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
