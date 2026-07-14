import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/auth/cron";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import { gatherSymbols, prewarmSymbol } from "@/lib/research-agent";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Evidence-cache prewarmer. Populates av_cache with each symbol's fundamentals /
// sentiment / insider evidence AHEAD of the scoring run, so a cold-start research
// run gets cache hits instead of bursting the hard-limited providers (Massive
// 5/min, GDELT 1/5s) past their walls mid-scoring. BOUNDED + RESUMABLE: a single
// Vercel invocation cannot run for minutes, so each tick warms symbols until a
// hard wall-clock budget, then RETURNS with how many remain — pg_cron fires it
// repeatedly (a few minutes apart) and the pacing lease + av_cache dedupe mean the
// queue drains across ticks. Already-warm symbols (14d fundamentals TTL) are
// near-instant cache hits, so each tick naturally advances to the cold tail.
//
// Read/warm ONLY: no scoring, no signal/packet writes, no order path. Cron-gated.
const WALL_CLOCK_MS = 45_000;

export async function POST(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    const gate = await requireOwner();
    if (gate) return gate;
  }
  const market = new URL(req.url).searchParams.get("market") === "india" ? "india" : "us";
  const svc = createServiceClient();

  // Weekend self-skip: markets are closed Sat/Sun and slow-moving evidence doesn't
  // change, so a weekend warm is only worth its (idle, daily-reset) quota when
  // there's real backlog to drain. Weekdays ALWAYS run (prewarm feeds the research
  // run). This lets prewarm be scheduled 7-day to use otherwise-wasted weekend
  // quota, without pointless runs when the queue is already shallow.
  const dow = new Date().getUTCDay(); // 0=Sun … 6=Sat
  if (dow === 0 || dow === 6) {
    const { count } = await svc.from("research_queue").select("symbol", { count: "exact", head: true }).eq("market", market);
    if ((count ?? 0) < 10) {
      return NextResponse.json({ market, skipped: true, reason: "weekend + shallow backlog", backlog: count ?? 0 });
    }
  }

  let universe;
  try {
    universe = await gatherSymbols(svc);
  } catch (e) {
    return NextResponse.json({ error: `gatherSymbols failed: ${String(e)}` }, { status: 500 });
  }

  // Scope to the requested market (india rows carry assetClass "india").
  const symbols = universe.filter(e => (market === "india" ? e.assetClass === "india" : e.assetClass !== "india"));

  const start = Date.now();
  let warmed = 0;
  for (const entry of symbols) {
    if (Date.now() - start >= WALL_CLOCK_MS) break; // bounded — leave the rest for the next tick
    try { await prewarmSymbol(entry); warmed++; } catch { /* fail-soft per symbol */ }
  }

  return NextResponse.json({
    market,
    warmed,
    total: symbols.length,
    remaining: Math.max(0, symbols.length - warmed),
    elapsed_ms: Date.now() - start,
  });
}
