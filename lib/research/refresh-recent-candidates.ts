import { getMarketDayStatus, isMarketSessionOpen } from "@/lib/trading/market-calendar";
import { reportIssue, resolveIssue } from "@/lib/system-health";
import type { RecentQualifiedCandidate } from "@/types";

/** Research only. Caller runs this AFTER its controls and before reading fresh signals. */
export async function refreshRecentCandidatesForCapacity(svc: any, market: "us" | "india", args: {
  hasCapacity: boolean; heldSymbols: string[]; now?: Date;
  // Injection keeps lifecycle tests deterministic and avoids invoking paid research.
  refresh?: (row: RecentQualifiedCandidate) => Promise<unknown>;
}): Promise<{ refreshed: number; failed: number }> {
  const now = args.now ?? new Date();
  if (!args.hasCapacity || !isMarketSessionOpen(market, now)) return { refreshed: 0, failed: 0 };
  const day = getMarketDayStatus(market, now);
  if (day.kind !== "trading_day") return { refreshed: 0, failed: 0 };
  const issueKey = `recent-candidates:${market}:refresh`;
  try {
    if (!args.refresh) {
      // Isolated research cannot certify a batch-relative rank percentile.
      const { data: champions, error: championError } = await svc.from("strategy_versions")
        .select("market,genome").eq("is_champion", true).order("promoted_at", { ascending: false });
      if (championError) throw new Error("Cannot certify candidate refresh rank policy");
      const champion = (champions ?? []).find((row: any) => row.market === market) ?? champions?.[0];
      const rankFloor = champion?.genome?.entry?.rank_pct_min;
      if (rankFloor != null && (typeof rankFloor !== "number" || !Number.isFinite(rankFloor) || rankFloor < 0 || rankFloor > 1)) {
        throw new Error("Candidate refresh rank policy is malformed");
      }
      if (rankFloor > 0) return { refreshed: 0, failed: 0 };
    }
    const { data, error } = await svc.rpc("claim_recent_candidate_refresh", {
      p_market: market, p_session: day.localYmd, p_excluded: args.heldSymbols,
    });
    if (error) throw new Error(error.message);
    const claimed: RecentQualifiedCandidate[] = data ?? [];
    if (claimed.length === 0) return { refreshed: 0, failed: 0 };
    const refresh = args.refresh ?? (async row => {
      const { processSymbol, isEtfSymbol, classifyResearchAssetClass } = await import("@/lib/research-agent");
      await processSymbol({ symbol: row.symbol, isHeld: false, isEtf: isEtfSymbol(row.symbol),
        assetClass: classifyResearchAssetClass(row.symbol),
        discovery_source: (row.discovery_source ?? "watchlist") as Parameters<typeof processSymbol>[0]["discovery_source"] }, svc);
      const { data: updated, error } = await svc.from("recent_qualified_candidates")
        .select("state,latest_session").eq("id", row.id).maybeSingle();
      if (error || !updated || updated.latest_session < day.localYmd) {
        throw new Error("Fresh assessment was not reflected in the candidate episode");
      }
    });
    let refreshed = 0, failed = 0, cursor = 0;
    const failures: string[] = [];
    // Reuse the normal research writer/score version, with bounded concurrency.
    await Promise.all(Array.from({ length: Math.min(2, claimed.length) }, async () => {
      while (cursor < claimed.length) {
        const row = claimed[cursor++];
        try { await refresh(row); refreshed++; }
        catch { failed++; failures.push(row.symbol); }
      }
    }));
    if (failed) await reportIssue({ issueKey, severity: "warn", category: "data",
      title: `${market.toUpperCase()} candidate refresh incomplete`,
      detail: `Fresh research failed for ${failures.join(", ")}. Old signals remain non-tradeable; bounded retry after lease expiry, maximum two attempts per session.` }, svc);
    else await resolveIssue(issueKey, svc);
    return { refreshed, failed };
  } catch (error) {
    await reportIssue({ issueKey, severity: "warn", category: "data", title: `${market.toUpperCase()} candidate refresh unavailable`,
      detail: error instanceof Error ? error.message : "Could not claim shortlist refresh work" }, svc).catch(() => {});
    return { refreshed: 0, failed: 1 };
  }
}
