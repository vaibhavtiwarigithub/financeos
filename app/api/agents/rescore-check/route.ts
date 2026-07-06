import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Re-scoring check: did the research agent mis-score anything?
// Compares each symbol's latest analyst_score to its realized price move since,
// and flags divergences so the LearnerAgent can revisit its scoring calibration:
//   - LOW score (<50, effectively "pass") but price rallied  → underscored (missed upside)
//   - HIGH score (>=60, "buy") but price fell                → overscored (thesis failing)
// Writes a [RESCORE] note to learning_log (the learner reads this) and returns flags.
// Cron-able via x-cron-secret. Uses price_cache only (no external API budget).

const LOOKBACK_DAYS = 30;
const MIN_DAYS_SINCE = 3;      // give the thesis time to play out
const UNDERSCORE_MOVE = 12;    // % up while scored low
const OVERSCORE_MOVE = -10;    // % down while scored high

export async function POST(req: NextRequest) {
  const cronSecret = req.headers.get("x-cron-secret");
  const isCron = cronSecret && cronSecret === process.env.CRON_SECRET;
  if (!isCron) {
    const userClient = await createClient();
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const svc = createServiceClient();
  const sinceSignals = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString();
  const sincePrices = new Date(Date.now() - (LOOKBACK_DAYS + 15) * 86400_000).toISOString().slice(0, 10);

  // Latest signal per symbol in the lookback window
  const { data: signals } = await svc.from("agent_signals")
    .select("symbol, analyst_score, direction, created_at")
    .gte("created_at", sinceSignals)
    .not("analyst_score", "is", null)
    .order("created_at", { ascending: false })
    .limit(500);

  const latest: Record<string, { score: number; date: string; direction: string }> = {};
  for (const s of (signals ?? []) as any[]) {
    if (!latest[s.symbol]) latest[s.symbol] = { score: Number(s.analyst_score), date: s.created_at, direction: s.direction };
  }
  const symbols = Object.keys(latest);
  if (!symbols.length) return NextResponse.json({ flags: [], checked: 0, message: "No scored signals in window" });

  // Price series per symbol from price_cache
  const { data: prices, error: priceErr } = await svc.from("price_cache")
    .select("symbol, date, close")
    .in("symbol", symbols)
    .gte("date", sincePrices)
    .order("date", { ascending: false });
  if (priceErr) return NextResponse.json({ error: `price_cache query failed: ${priceErr.message}` }, { status: 500 });

  const bySymbol: Record<string, { date: string; close: number }[]> = {};
  for (const p of (prices ?? []) as any[]) {
    (bySymbol[p.symbol] ??= []).push({ date: p.date, close: Number(p.close) });
  }

  const flags: any[] = [];
  const now = Date.now();
  for (const sym of symbols) {
    const sig = latest[sym];
    const rows = bySymbol[sym];
    if (!rows?.length) continue;

    const sigDay = sig.date.slice(0, 10);
    const daysSince = (now - new Date(sig.date).getTime()) / 86400_000;
    if (daysSince < MIN_DAYS_SINCE) continue;

    const currentClose = rows[0].close; // rows sorted date desc
    const signalRow = rows.find(r => r.date <= sigDay) ?? rows[rows.length - 1];
    const signalClose = signalRow.close;
    if (!currentClose || !signalClose) continue;

    const movePct = ((currentClose - signalClose) / signalClose) * 100;

    let flag: string | null = null;
    if (sig.score < 50 && movePct > UNDERSCORE_MOVE) {
      flag = `UNDERSCORED: ${sym} scored ${sig.score}/100 (${sig.direction}) but +${movePct.toFixed(1)}% since ${sigDay} — scoring may under-weight this setup`;
    } else if (sig.score >= 60 && movePct < OVERSCORE_MOVE) {
      flag = `OVERSCORED: ${sym} scored ${sig.score}/100 (${sig.direction}) but ${movePct.toFixed(1)}% since ${sigDay} — thesis failing, scoring too generous`;
    }
    if (flag) flags.push({ symbol: sym, score: sig.score, movePct: Number(movePct.toFixed(1)), daysSince: Math.round(daysSince), note: flag });
  }

  // Dedup: don't re-insert the same symbol+type flag while it's still recent.
  // Otherwise a daily cron floods learning_log and over-weights one divergence.
  const { data: recentFlags } = await svc.from("learning_log")
    .select("note").ilike("note", "[RESCORE]%").gte("created_at", new Date(Date.now() - 7 * 86400_000).toISOString());
  const seen = new Set<string>();
  for (const r of (recentFlags ?? []) as any[]) {
    const m = String(r.note).match(/\[RESCORE\]\s+(UNDERSCORED|OVERSCORED):\s+(\S+)/);
    if (m) seen.add(`${m[1]}:${m[2]}`);
  }

  let inserted = 0;
  for (const f of flags) {
    const type = f.note.startsWith("UNDERSCORED") ? "UNDERSCORED" : "OVERSCORED";
    const key = `${type}:${f.symbol}`;
    if (seen.has(key)) continue;   // already flagged in the last 7 days
    seen.add(key);
    await svc.from("learning_log").insert({ note: `[RESCORE] ${f.note}`, weight_snapshot: null, trades_evaluated: 0 });
    inserted++;
  }

  // "evaluated" = symbols that actually had price data (not just candidates).
  const evaluated = symbols.filter(s => (bySymbol[s]?.length ?? 0) > 0).length;
  return NextResponse.json({ candidates: symbols.length, evaluated, flagged: flags.length, new_flags: inserted, flags });
}

// GET: recent rescore flags (from learning_log)
export async function GET(req: NextRequest) {
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const svc = createServiceClient();
  const { data } = await svc.from("learning_log")
    .select("note, created_at")
    .ilike("note", "[RESCORE]%")
    .order("created_at", { ascending: false })
    .limit(50);
  return NextResponse.json({ flags: data ?? [] });
}
