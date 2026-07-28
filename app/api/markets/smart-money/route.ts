import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { TRADE_PROPOSAL_VISIBLE_STATUSES } from "@/lib/trading/proposal-status";

export const dynamic = "force-dynamic";

// Client data source for the Smart Money tab (merged into the Intelligence
// page). Mirrors the queries the old /dashboard/smart-money server page ran,
// scoped to the selected market (?market=us|india). Owner-gated + service
// client because agent_signals / trade_proposals are not client-readable.
//
// Every market-scoped query is resilient: if the `market` column doesn't
// exist yet (pre-057) the filtered query errors, so we retry unscoped and
// fall back to the US path unchanged.
async function selectScoped<T>(
  market: "us" | "india",
  run: (applyMarket: boolean) => PromiseLike<{ data: T | null; error: unknown }>
): Promise<T | null> {
  const withFilter = await run(true);
  if (!withFilter.error) return withFilter.data;
  // A pre-market-column schema is US-only. Returning those rows for an India
  // request would silently relabel US signals/proposals as India data.
  if (market === "india") return null;
  const unscoped = await run(false);
  return unscoped.data;
}

export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const market = new URL(req.url).searchParams.get("market") === "india" ? "india" : "us";
  const svc = createServiceClient();
  const since30 = new Date(Date.now() - 30 * 86400_000).toISOString();
  const since7 = new Date(Date.now() - 7 * 86400_000).toISOString();

  const [signals, tradeQueue, highInsider] = await Promise.all([
    selectScoped<any[]>(market, (applyMarket) => {
      let q = svc
        .from("agent_signals")
        .select("symbol,direction,analyst_score,insider_score,technical_score,fundamental_score,sentiment_score,macro_score,created_at,asset_class,source")
        .gte("created_at", since30);
      if (applyMarket) q = q.eq("market", market);
      return q.order("analyst_score", { ascending: false }).limit(60);
    }),
    selectScoped<any[]>(market, (applyMarket) => {
      // trade_proposals — the canonical table /api/agents/trader and the
      // Execution Gateway operate on. Aliased to the field names the UI expects.
      let q = svc
        .from("trade_proposals")
        .select("id, symbol, order_side:side, qty, limit_price, analyst_score, rationale:thesis, status, created_at, account_number")
        .in("status", TRADE_PROPOSAL_VISIBLE_STATUSES);
      if (applyMarket) q = q.eq("market", market); // no market column on trade_proposals yet — resiliently falls back unscoped
      return q.order("created_at", { ascending: false }).limit(30);
    }),
    selectScoped<any[]>(market, (applyMarket) => {
      let q = svc
        .from("agent_signals")
        // `id` is required to recover the availability flag — see below.
        .select("id,symbol,analyst_score,insider_score,direction,created_at,asset_class")
        .gte("created_at", since7)
        .gte("insider_score", 55);
      if (applyMarket) q = q.eq("market", market);
      return q.order("insider_score", { ascending: false }).limit(20);
    }),
  ]);

  // ---------------------------------------------------------------------
  // Insider availability
  //
  // `agent_signals.insider_score` is lossy: the scorers return
  // { score, available }, but only `score` is persisted, so an unavailable
  // neutral 50 (fetch failed / too few filings / India, which has no EDGAR at
  // all) is indistinguishable from a genuinely balanced 50. Reading a 50 as
  // "insiders aren't buying" when it means "we never got insider data" is the
  // opposite conclusion for a trading decision.
  //
  // It does NOT need a new column: `decision_observations.availability_mask`
  // already records this per decision and links back via `signal_id`. Verified
  // in prod (2026-07-16) — every one of the 436 observation rows carries an
  // insider flag, including 18 us rows that are genuinely available AND exactly
  // 50. Those 18 are why the "treat any 50 as unavailable" heuristic was
  // rejected: it would misreport real balanced data as missing.
  //
  // A signal we cannot prove is excluded rather than assumed good — an
  // unprovable claim must not reach a trading surface as a finding.
  const insiderCandidates = highInsider ?? [];
  let verifiedInsider: any[] = [];
  let unverifiedCount = 0;

  if (insiderCandidates.length > 0) {
    const ids = insiderCandidates.map((s: any) => s.id).filter(Boolean);
    const { data: obs, error: obsError } = await svc
      .from("decision_observations")
      .select("signal_id,availability_mask")
      .in("signal_id", ids);

    if (obsError) {
      // Cannot verify => cannot claim. Fail closed, and say so.
      unverifiedCount = insiderCandidates.length;
    } else {
      const availableSignalIds = new Set(
        (obs ?? [])
          .filter((o: any) => String(o?.availability_mask?.insider) === "true")
          .map((o: any) => o.signal_id)
      );
      verifiedInsider = insiderCandidates.filter((s: any) => availableSignalIds.has(s.id));
      unverifiedCount = insiderCandidates.length - verifiedInsider.length;
    }
  }

  return NextResponse.json({
    signals: signals ?? [],
    tradeQueue: tradeQueue ?? [],
    highInsider: verifiedInsider,
    // Lets the UI distinguish "insiders aren't buying" from "insider data is
    // unavailable for this market" (India has no EDGAR equivalent wired up, so
    // its insider dimension is honestly unavailable — not neutral).
    insiderCoverage: {
      candidates: insiderCandidates.length,
      verifiedAvailable: verifiedInsider.length,
      excludedUnavailable: unverifiedCount,
    },
    market,
  });
}
