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

async function sendBriefingEmail(svc: any, session: "morning" | "evening", dateStr: string, dayName: string, content: string): Promise<void> {
  const resendKey = await getResendKey(svc);
  if (!resendKey) return;

  const icon = session === "morning" ? "☀️" : "🌙";
  const label = session === "morning" ? "Morning Briefing" : "Evening Summary";
  const subject = `${icon} Kairos ${label} — ${dayName}, ${dateStr}`;

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#0D0F14;font-family:'Inter',Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <div style="background:#1A1D27;border:1px solid #252836;border-radius:16px;overflow:hidden">
    <div style="background:linear-gradient(135deg,#6366F1,#4F46E5);padding:24px 28px">
      <div style="font-size:11px;color:rgba(255,255,255,0.7);letter-spacing:0.15em;text-transform:uppercase;margin-bottom:6px">Kairos</div>
      <div style="font-size:22px;font-weight:700;color:#fff">${icon} ${label}</div>
      <div style="font-size:13px;color:rgba(255,255,255,0.8);margin-top:4px">${dayName}, ${dateStr}</div>
    </div>
    <div style="padding:24px 28px;color:#9B9EA8;font-size:14px;line-height:1.7">
      <p style="margin:0 0 12px;color:#9B9EA8;line-height:1.6">${mdToHtml(content)}</p>
    </div>
    <div style="padding:16px 28px;border-top:1px solid #252836;font-size:11px;color:#6B7280">
      Kairos Agentic Quant Platform · <a href="http://localhost:3000/dashboard/briefing" style="color:#6366F1;text-decoration:none">View in app →</a>
    </div>
  </div>
</div>
</body></html>`;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "Kairos <onboarding@resend.dev>",
        to: [ADMIN_EMAIL],
        subject,
        html,
      }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.error(`[briefing-email] Resend ${res.status}: ${errBody}`);
    }
  } catch (e) {
    console.error("[briefing-email] fetch error:", e);
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
  ]);

  // Enrich positions with current price from price_cache
  const positions = rawPositions ?? [];
  const positionLines: string[] = [];
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
    } else {
      positionLines.push(`  • ${p.symbol} ${p.direction?.toUpperCase()}: ${p.quantity} shares @ $${entryPrice.toFixed(2)} entry (price unavailable)`);
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

  const morningPrompt = `You are a personal AI investment assistant preparing a ${sessionLabel} for ${dayName}, ${dateStr}.

${contextBlock}

Write a concise morning briefing (200-300 words). Use ONLY the data above — do not invent market moves, analyst notes, or events not mentioned. If data says "unavailable" or "none", say so directly rather than guessing.

Structure:
**1. TODAY'S FOCUS** — what to watch today, based on actual signals and earnings above
**2. PORTFOLIO STATUS** — reference specific positions by name with their actual P&L from context
**3. RISK WATCH** — any concern from the actual data (high IV, earnings risk on positions, etc.)
**4. ONE THING** — single most important action for today

Second person, present tense. Specific. No disclaimers. No invented data.`;

  const eveningPrompt = `You are a personal AI investment assistant preparing an ${sessionLabel} for ${dayName}, ${dateStr}.

${contextBlock}

Write a concise evening summary (200-300 words). Use ONLY the data above — do not invent market moves, analyst notes, or events not in context. If index data shows actual closes, cite them. If positions show specific P&L, cite them. Do not say "markets were mixed" unless the index data supports it.

Structure:
**1. WHAT HAPPENED** — cite actual index closes from context. If unavailable, say so.
**2. POSITIONS CHECK** — each open position by name with actual P&L from context
**3. TOMORROW PREP** — reference actual upcoming earnings and pending signals from context
**4. LEARNING** — reference actual learning log entries, or state Phase 0 status if no closed trades

Second person, past tense for today / future tense for tomorrow. No invented catalysts, reports, or analyst notes. No disclaimers.`;

  const result = await callLLM({
    task: "summarize",
    prompt: session === "morning" ? morningPrompt : eveningPrompt,
    maxTokens: 600,
  });
  const content = result.text;

  await svc.from("briefings").upsert(
    { date: dateStr, session, content, model: "auto" },
    { onConflict: "date,session" }
  );

  // Send email — fire and await (briefing is the email, not fire-and-forget)
  await sendBriefingEmail(svc, session, dateStr, dayName, content);

  // Mark email sent
  await svc.from("briefings")
    .update({ email_sent_at: new Date().toISOString() })
    .eq("date", dateStr)
    .eq("session", session);

  return NextResponse.json({ session, date: dateStr, content, email_sent: true });
}
