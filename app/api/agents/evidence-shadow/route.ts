import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";
import { resolveEvidence } from "@/lib/evidence/resolver";
import { ADAPTERS_BY_INTENT } from "@/lib/evidence/registry";
import { isMarket, type EvidenceIntent, type Market } from "@/lib/evidence/contracts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Canonical Evidence Router — DUAL-RUN SHADOW (Phase 2, observational only).
//
// Resolves the router-covered evidence intents over a market's watchlist universe
// and records every attempt to the append-only provider_call_ledger + canonical
// evidence_cache_v2 (both handled inside resolveEvidence). router_enabled stays
// false, so this NEVER feeds scoring, signals, cash, positions, or orders — it
// exists purely to prove the resolver on live data and accumulate the coverage /
// disagreement evidence the Phase-4 cutover will be gated on.
//
// DECOUPLED from the research hot path on purpose: running the resolver inside
// the 50-symbol research run would add latency and risk its cron timeout. This is
// its own bounded (45s), RESUMABLE tick — a fresh cache short-circuits an
// already-resolved symbol, so repeated ticks advance to the cold tail (same shape
// as prewarm). Idempotent + fail-soft: one symbol's error never aborts the run.
//
// GET/POST /api/agents/evidence-shadow?market=us|india  (owner- or cron-gated)

const WALLCLOCK_MS = 45_000;

// Only intents that actually have a registered adapter are worth shadowing.
const SHADOW_INTENTS = (Object.keys(ADAPTERS_BY_INTENT) as EvidenceIntent[]);
const MARKET_WIDE_INTENTS = new Set<EvidenceIntent>(["macro.regime_inputs"]);

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    const gate = await requireOwner();
    if (gate) return gate;
  }
  const marketParam = req.nextUrl.searchParams.get("market") ?? "us";
  if (!isMarket(marketParam)) {
    return NextResponse.json({ error: `invalid market '${marketParam}'` }, { status: 400 });
  }
  const market: Market = marketParam;
  const svc = createServiceClient();

  // Weekend self-skip (mirrors prewarm): only accumulate shadow evidence on Sat/Sun
  // when there's backlog worth draining; weekdays always run. Lets this be a 7-day
  // cron that uses idle weekend capacity without pointless runs.
  const dow = new Date().getUTCDay();
  if (dow === 0 || dow === 6) {
    const { count } = await svc.from("research_queue").select("symbol", { count: "exact", head: true }).eq("market", market);
    if ((count ?? 0) < 10) {
      return NextResponse.json({ market, skipped: true, reason: "weekend + shallow backlog", backlog: count ?? 0 });
    }
  }

  const started = Date.now();

  // Universe = research-enabled watchlist for this market (the same names research
  // rotates). Bounded; the cache short-circuit makes repeated ticks resumable.
  const marketFilter = market === "india" ? ["india"] : ["us", "Global", "Crypto", "US"];
  const nowIso = new Date().toISOString();
  const [wlRes, rqRes, sigRes] = await Promise.all([
    svc
      .from("watchlist")
      .select("symbol, market, research_enabled, expires_at")
      .in("market", marketFilter)
      .or(`expires_at.is.null,expires_at.gt.${nowIso}`),
    // research_queue only holds carry-forward OVERFLOW (names that didn't fit a
    // research run's cap) — it drains to 0 whenever research keeps up, which is
    // the healthy case. It is NOT a standing India universe.
    svc.from("research_queue").select("symbol").eq("market", market),
    // India's actual research universe (holdings + live screener picks) is never
    // persisted anywhere stable — it's recomputed fresh every research run. The
    // nearest durable proxy is agent_signals: every symbol research touches gets
    // a row there. Without this, watchlist(india)=always empty + research_queue
    // drained-to-0 means the India shadow universe silently goes empty for days
    // and no India evidence ever accumulates. Scoped to market=india only; US
    // already has a real watchlist and doesn't need this fallback.
    market === "india"
      ? svc.from("agent_signals").select("symbol").eq("market", "india").gte("created_at", new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString())
      : Promise.resolve({ data: [] as any[] }),
  ]);

  const symbols = [...new Set<string>([
    ...((wlRes.data ?? []) as any[])
      .filter((r: any) => r.research_enabled !== false)
      .map((r: any) => String(r.symbol).toUpperCase()),
    ...((rqRes.data ?? []) as any[]).map((r: any) => String(r.symbol).toUpperCase()),
    ...((sigRes.data ?? []) as any[]).map((r: any) => String(r.symbol).toUpperCase()),
  ])];

  let resolvedFresh = 0, resolvedLive = 0, unavailable = 0, symbolsDone = 0;
  const perIntent: Record<string, { ok: number; unavailable: number }> = {};

  // Market-wide facts are resolved once, never once per symbol. The observed
  // macro adapter is cache-fed by ResearchAgent and performs no external call.
  for (const intent of SHADOW_INTENTS.filter((value) => MARKET_WIDE_INTENTS.has(value))) {
    perIntent[intent] = { ok: 0, unavailable: 0 };
    try {
      const env = await resolveEvidence({ market, intent, runId: `shadow:${market}`, allowDisabledPolicy: true });
      if (env.quality === "fresh" && env.cacheState === "fresh") resolvedFresh++;
      else if (env.quality === "fresh") resolvedLive++;
      if (env.payload != null) perIntent[intent].ok++;
      else { unavailable++; perIntent[intent].unavailable++; }
    } catch {
      unavailable++;
      perIntent[intent].unavailable++;
    }
  }

  outer:
  for (const symbol of symbols) {
    if (Date.now() - started > WALLCLOCK_MS) break;
    symbolsDone++;
    for (const intent of SHADOW_INTENTS.filter((value) => !MARKET_WIDE_INTENTS.has(value))) {
      if (Date.now() - started > WALLCLOCK_MS) break outer;
      perIntent[intent] ??= { ok: 0, unavailable: 0 };
      try {
        const env = await resolveEvidence({
          market,
          intent,
          symbol,
          runId: `shadow:${market}`,
          allowDisabledPolicy: true,
        });
        if (env.quality === "fresh" && env.cacheState === "fresh") resolvedFresh++;
        else if (env.quality === "fresh") resolvedLive++;
        if (env.payload != null) perIntent[intent].ok++;
        else { unavailable++; perIntent[intent].unavailable++; }
      } catch {
        unavailable++;
        perIntent[intent].unavailable++;
      }
    }
  }

  return NextResponse.json({
    ok: true,
    market,
    ranAt: new Date().toISOString(),
    universe: symbols.length,
    symbolsProcessed: symbolsDone,
    remaining: Math.max(0, symbols.length - symbolsDone),
    intents: SHADOW_INTENTS,
    resolvedFreshCache: resolvedFresh,
    resolvedLive,
    unavailable,
    perIntent,
    note: "shadow-only — router_enabled=false; logged to provider_call_ledger + evidence_cache_v2, never scored",
  });
}

export const POST = GET;
