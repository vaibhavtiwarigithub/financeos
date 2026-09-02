import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { gatherSymbols, processSymbol } from "@/lib/research-agent";
import { buildDiscoverySnapshotMembers } from "@/lib/research/discovery-ledger";
import { computeComparableRank, isRankRejected, type RankCandidate } from "@/lib/scoring/rank";
import { isIndia } from "@/lib/india-data";
import { completeDeferred, enqueueDeferred, readDeferredCandidates } from "@/lib/research-queue";
import { prewarmPriceCache } from "@/lib/chart-data";
import { resolvePrewarmScope, PREWARM_RECENT_DECISION_DAYS } from "@/lib/data/prewarm-scope";
import { RISK_PROFILES } from "@/lib/risk-profiles";
import { verifyCronSecret } from "@/lib/auth/cron";
import { emitAlert } from "@/lib/alerts/emit";
import { reportIssue, resolveIssue } from "@/lib/system-health";
import { runAccountingEnvelope } from "@/lib/monitoring/run-accounting";
import {
  getClosedDayCatchupEligibility,
  getMarketDayStatus,
  isMarketWeekend,
  lastCompletedMarketSession,
  admitMarketLocalSlot,
} from "@/lib/trading/market-calendar";

export const dynamic = "force-dynamic";
// Research is independently wall-clock bounded. Discovery jobs such as Theme
// Scout run on their own schedule and never consume this route's time budget.
export const maxDuration = 150;

// Per-symbol hard ceiling. The worker loop only checks the wall-clock budget
// BETWEEN symbols, so a single processSymbol() that HANGS (a DB read or fetch
// with no internal timeout stuck on a provider/Supabase outage) would stall its
// worker forever, Promise.all would never resolve, and the whole function would
// blow past maxDuration and be watchdog-reaped as ERROR (prod: US research
// 2026-07-24 during a Supabase 525 outage). Racing each symbol against this
// deadline turns one hung symbol into a deferred symbol, not a dead run.
const PER_SYMBOL_TIMEOUT_MS = (() => {
  const v = Number(process.env.RESEARCH_SYMBOL_TIMEOUT_MS ?? 30_000);
  return Number.isFinite(v) ? Math.min(60_000, Math.max(10_000, v)) : 30_000;
})();

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`processSymbol timed out after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([p.finally(() => clearTimeout(timer)), timeout]);
}

function sanitizeResearchError(value: unknown): string {
  return String(value)
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, "$1[redacted]")
    .replace(/([?&](?:api_?key|token|access_token|secret)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\s+/g, " ")
    .slice(0, 180);
}

// Called by Windows Task Scheduler. US run ~9 AM ET; India run ~6:15 AM ET (after
// the 15:30 IST / 06:00 ET NSE close). `?market=us|india` scopes the run to one
// market so each fires on its own market's schedule and only touches its own
// symbols. No param = legacy all-symbols behavior.
// curl -X POST "http://localhost:3000/api/agents/research/cron?market=india" -H "x-cron-secret: <CRON_SECRET>"
export async function POST(req: NextRequest) {
  const routeStartedAt = Date.now();
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const mktParam = url.searchParams.get("market");
  const marketScope = mktParam === "india" ? "india" : mktParam === "us" ? "us" : null;
  const catchupMode = url.searchParams.get("mode");
  // Read with the other params: gatherSymbols needs it well before the entry filter.
  const discoveryOnly = url.searchParams.get("scope") === "discovery";
  const closedDayCatchup = catchupMode === "closed_day_catchup" || catchupMode === "weekend_catchup";
  if (closedDayCatchup && !marketScope) {
    return NextResponse.json({ error: "Closed-day catch-up requires market=us|india" }, { status: 400 });
  }

  const localSlot = url.searchParams.get("local_slot");
  if (localSlot) {
    if (!marketScope) return NextResponse.json({ error: "local_slot requires market=us|india" }, { status: 400 });
    const slot = admitMarketLocalSlot(marketScope, localSlot);
    if (!slot.admitted) {
      return NextResponse.json({ skipped: true, reason: slot.reason, expected: localSlot, local_time: slot.localTime });
    }
  }

  const supabase = createServiceClient();

  // One exchange-specific calendar owns both normal-run closure checks and
  // catch-up eligibility. The daily catch-up jobs self-skip on trading days,
  // unsupported calendar years, and special sessions such as Muhurat Trading.
  const dayMarket = marketScope ?? "us";
  const dayStatus = getMarketDayStatus(dayMarket);
  const catchupEligibility = getClosedDayCatchupEligibility(dayMarket);
  const calendarIssueKey = `market-calendar-unsupported:${dayMarket}`;
  if (dayStatus.kind === "unsupported_year") {
    await reportIssue({
      issueKey: calendarIssueKey,
      severity: "warn",
      category: "cron",
      title: `Research: ${dayMarket.toUpperCase()} market calendar needs annual update`,
      detail: `No verified equity-market calendar is installed for ${dayStatus.localYmd.slice(0, 4)}. Closed-day catch-up is disabled; normal weekdays remain available.`,
    }, supabase);
  } else {
    await resolveIssue(calendarIssueKey, supabase);
  }
  if (closedDayCatchup && !catchupEligibility.eligible) {
    return NextResponse.json({
      skipped: true,
      reason: `Closed-day catch-up refused: ${catchupEligibility.reason} (${catchupEligibility.localYmd})`,
    });
  }
  if (!closedDayCatchup && (dayStatus.kind === "weekend" || dayStatus.kind === "holiday")) {
    return NextResponse.json({ skipped: true, reason: `${dayStatus.kind}: market closed (${dayStatus.localYmd})` });
  }
  if (!closedDayCatchup && dayStatus.kind === "special_session") {
    return NextResponse.json({
      skipped: true,
      reason: `Special session requires an explicit session schedule (${dayStatus.localYmd})`,
    });
  }
  if (!closedDayCatchup && dayStatus.kind === "unsupported_year" && isMarketWeekend(dayMarket)) {
    return NextResponse.json({ skipped: true, reason: `Calendar year unsupported (${dayStatus.localYmd})` });
  }

  // NOTE: research is deliberately NOT gated by app_paused. app_paused is the
  // drawdown circuit breaker — it pauses new ENTRIES (paper-trade checks it and
  // skips), not measurement. Gating research here meant one market's drawdown
  // pause silently blinded the WHOLE pipeline: no scoring, no signals, no
  // decision-ledger/learning data, and (as seen 2026-07-13) a phantom India
  // drawdown skipped the entire US research run. Research always scores; only
  // the downstream entry path respects the pause.

  // Posture auto-revert (Part B) — resilient: absent columns pre-migration → no-op.
  try {
    const { data: postureCfg } = await supabase
      .from("strategy_config")
      .select("id, posture, posture_expires_at, base_risk_profile")
      .limit(1)
      .maybeSingle();
    if (postureCfg?.posture && postureCfg.posture_expires_at && new Date(postureCfg.posture_expires_at) <= new Date()) {
      const base = (postureCfg.base_risk_profile ?? "balanced") as keyof typeof RISK_PROFILES;
      await supabase.from("strategy_config").update({
        ...RISK_PROFILES[base], risk_profile: base, posture: null, posture_expires_at: null, base_risk_profile: null,
      } as any).eq("id", postureCfg.id);
      await supabase.from("decision_journal").insert({
        entry_type: "posture_expired",
        summary: `Posture ${postureCfg.posture} expired, reverted to ${base}`,
      } as any);
    }
  } catch { /* pre-migration schema — no-op */ }

  // Idempotency guard — a duplicate/manual re-trigger within 30 min shouldn't
  // re-run the pass. But it must be PER MARKET: a US run at 9 AM must not suppress
  // the India run, and vice-versa. Filter the persisted market explicitly so each
  // recent run's market from its symbols (any .NS/.BO → India) and only block when
  // a run for THIS market is in the window.
  const runAgentType = closedDayCatchup ? "research_closed_day" : "research";
  const guardWindow = new Date(Date.now() - 30 * 60_000).toISOString();
  const { data: recentRuns } = await supabase
    .from("agent_runs")
    .select("id, status, started_at, symbols, market")
    .eq("agent_type", runAgentType)
    .eq("market", marketScope ?? "us")
    .gte("started_at", guardWindow)
    .order("started_at", { ascending: false })
    .limit(5);
  const guardMarket = marketScope ?? "us";
  const recentRun = (recentRuns ?? [])[0];
  if (recentRun) {
    return NextResponse.json({
      skipped: true,
      reason: `Research (${guardMarket}) already ran (or is running) within the last 30 minutes — run ${(recentRun as any).id} started at ${(recentRun as any).started_at}`,
    });
  }

  // Theme Scout is scheduled independently; research consumes the validated
  // watchlist state available when this run starts.

  let queueDepthAtStart: number | null = null;
  let allEntries;
  if (closedDayCatchup && marketScope) {
    const queuedRows = await readDeferredCandidates(supabase, marketScope);
    const queued = queuedRows.map((q) => q.symbol);
    queueDepthAtStart = queued.length;
    const asOfSession = lastCompletedMarketSession(marketScope);
    const { data: alreadyStaged } = await supabase.from("agent_signals")
      .select("symbol")
      .eq("market", marketScope)
      .eq("status", "weekend_staged")
      .eq("as_of_session", asOfSession);
    const staged = new Set((alreadyStaged ?? []).map((row: any) => String(row.symbol).toUpperCase()));
    const configuredCap = marketScope === "india"
      ? Number.parseInt(process.env.RESEARCH_INDIA_CANDIDATE_CAP ?? "8", 10)
      : Number.parseInt(process.env.RESEARCH_CANDIDATE_CAP ?? "40", 10);
    const cap = Number.isFinite(configuredCap) ? Math.max(1, configuredCap) : 8;
    const catchupSymbols = queued.filter((symbol) => !staged.has(symbol)).slice(0, cap);
    allEntries = catchupSymbols.length > 0 ? await gatherSymbols(supabase, catchupSymbols, marketScope) : [];
  } else {
    allEntries = await gatherSymbols(supabase, undefined, marketScope ?? undefined, { discoveryScope: discoveryOnly });
  }
  // Scope to the requested market: India run researches only .NS/.BO names; US run
  // only non-India. No param → everything (legacy).
  const marketEntries = marketScope === "india" ? allEntries.filter(e => isIndia(e.symbol))
    : marketScope === "us" ? allEntries.filter(e => !isIndia(e.symbol))
    : allEntries;

  // `scope=discovery` — the discovery-only run.
  //
  // gatherSymbols orders candidates holdings → manual watchlist → carry-forward
  // → watchlist → screener, and the wall-clock budget cuts from the tail. With
  // 54 US holdings and 16 watchlist names against a ~100-symbol batch that
  // already defers ~51, screener candidates sat permanently at the back and were
  // NEVER scored — zero screener-sourced decisions for the whole of 2026-07,
  // regardless of whether discovery itself worked. Discovery and exit
  // re-scoring were competing for one budget, and exits rightly win, so the
  // funnel could never contribute evidence.
  //
  // This run takes only the never-held discovery buckets on its own schedule and
  // budget. Holdings are excluded outright, so nothing here can touch an
  // exit/SELL path.
  // Alert keys are scoped by run type: the two runs cover different symbol sets,
  // so a shared key would let one resolve what the other had just raised.
  const runTag = `${marketScope ?? "mixed"}${discoveryOnly ? ":discovery" : ""}`;
  const DISCOVERY_SOURCES = ["screener_momentum", "screener_value", "edge_relative_strength", "metals_basket", "region_etf", "india_screener"];
  const entries = discoveryOnly
    ? marketEntries.filter(e => !e.isHeld && DISCOVERY_SOURCES.includes(String(e.discovery_source ?? "")))
    : marketEntries;
  const batch = entries.map(e => e.symbol);
  // Set queue depth now that entries is resolved (closedDayCatchup already set this
  // for catchup runs; for normal session runs it was always null — set it here).
  if (queueDepthAtStart === null) queueDepthAtStart = entries.length;

  if (entries.length === 0) {
    return NextResponse.json({ skipped: true, reason: `No ${marketScope ?? "any"}-market symbols to research (check market_focus).` });
  }

  const { data: runRow } = await supabase.from("agent_runs").insert({
    agent_type: runAgentType,
    status: "running",
    market: marketScope ?? "us",
    symbols: batch,
    trigger_source: "scheduled",
  } as any).select().single();
  const runId = (runRow as any)?.id ?? null;

  // P1: create a universe snapshot before scoring so every decision_observations
  // row can be linked to the PIT universe. Fail-soft: missing table pre-137 → no-op.
  let universeSnapshotId: number | null = null;
  try {
    const { data: snapRow } = await supabase.from("universe_snapshots").insert({
      run_id: runId ? String(runId) : null,
      market: marketScope ?? "us",
      source: "mixed",   // holdings + screener + watchlist gathered together
      symbol_count: batch.length,
      symbols: batch,
    }).select("id").single();
    universeSnapshotId = (snapRow as any)?.id ?? null;
  } catch { /* pre-137 schema — no-op */ }

  // Parallel processing — RESEARCH_PARALLEL workers run concurrently so 42 symbols
  // finish in ceil(42/N) rounds instead of serially. Default 5 keeps well inside
  // the 150s maxDuration (42/5 rounds × ~8s each ≈ 72s). Raise carefully: AV free
  // tier is 5 req/min, but av-cache absorbs repeat calls so burst is rare.
  // Preserve batch admission before scoring. This lets Miss Review distinguish
  // never-admitted symbols from later score, gate, or portfolio rejections.
  // The ledger is audit-only and cannot affect research, scoring, or execution.
  if (universeSnapshotId && marketScope) {
    const members = buildDiscoverySnapshotMembers(universeSnapshotId, marketScope, entries);
    if (members.length > 0) {
      const { error: ledgerError } = await supabase
        .from("discovery_snapshot_members")
        .insert(members);
      if (ledgerError) {
        const detail = sanitizeResearchError(ledgerError.message ?? ledgerError);
        console.error("[research-cron] discovery ledger insert failed:", detail);
        await reportIssue({
          issueKey: `research-discovery-ledger:${marketScope}`,
          severity: "warn",
          category: "data",
          title: `${marketScope.toUpperCase()} discovery provenance was not recorded`,
          detail: `Research continued, but this run cannot be fully reconstructed in Miss Review: ${detail}`,
          autoExpireAt: new Date(new Date().setUTCHours(24, 0, 0, 0)).toISOString(),
        }, supabase).catch(() => {});
      } else {
        await resolveIssue(`research-discovery-ledger:${marketScope}`, supabase).catch(() => {});
      }
    }
  }

  const configuredConcurrency = Number.parseInt(process.env.RESEARCH_PARALLEL ?? "5", 10);
  const concurrency = Number.isFinite(configuredConcurrency)
    ? Math.min(10, Math.max(1, configuredConcurrency))
    : 5;
  // WALL-CLOCK BUDGET: stop starting new symbols once this elapses, leaving the
  // rest of maxDuration (150s) for the rank pass + finalize + chained paper-trade.
  // Previously the loop was unbounded, so a large cap (50) blew past maxDuration
  // mid-run and the function was killed before finalizing → watchdog-reaped ERROR
  // with only partial signals. Now the loop is time-bounded: whatever doesn't fit
  // is re-deferred to the front of the research queue for the next run, so a
  // higher cap raises throughput on warm/fast runs WITHOUT ever timing out.
  const configuredBudget = Number(process.env.RESEARCH_BUDGET_MS ?? 105_000);
  // This is an end-to-end route deadline, not a fresh timer after Theme Scout.
  // Cap it at 105s so rank/finalize/paper chaining retain >=45s of maxDuration.
  const BUDGET_MS = Number.isFinite(configuredBudget)
    ? Math.min(105_000, Math.max(15_000, configuredBudget))
    : 105_000;
  const processingDeadline = routeStartedAt + BUDGET_MS;
  const results: any[] = new Array(entries.length);
  const holdingIndexes = entries.map((entry, i) => entry.isHeld ? i : -1).filter(i => i >= 0);
  // Discovery sources (screener/basket) are promoted to the front of the candidate
  // queue so worker-0 (the candidate-preferring worker) scores new names before
  // watchlist re-scores. gatherSymbols orders watchlist ahead of screener, which
  // caused screener candidates to be structurally last and always budget-cut.
  const candidateIndexes = entries
    .map((entry, i) => !entry.isHeld ? i : -1)
    .filter(i => i >= 0)
    .sort((a, b) => {
      const aDisc = DISCOVERY_SOURCES.includes(String((entries[a] as any).discovery_source ?? "")) ? 0 : 1;
      const bDisc = DISCOVERY_SOURCES.includes(String((entries[b] as any).discovery_source ?? "")) ? 0 : 1;
      return aDisc - bDisc;
    });
  let holdingCursor = 0;
  let candidateCursor = 0;
  const takeIndex = (preferred: "holding" | "candidate"): number | null => {
    if (preferred === "candidate" && candidateCursor < candidateIndexes.length) return candidateIndexes[candidateCursor++];
    if (preferred === "holding" && holdingCursor < holdingIndexes.length) return holdingIndexes[holdingCursor++];
    if (holdingCursor < holdingIndexes.length) return holdingIndexes[holdingCursor++];
    if (candidateCursor < candidateIndexes.length) return candidateIndexes[candidateCursor++];
    return null;
  };
  async function worker(preferred: "holding" | "candidate") {
    while (Date.now() < processingDeadline) {
      const i = takeIndex(preferred);
      if (i == null) break;
      const entry = entries[i];
      try {
        results[i] = await withTimeout(
          processSymbol(
            entry,
            supabase,
            universeSnapshotId,
            runId ? String(runId) : null,
            closedDayCatchup && marketScope ? {
              status: "weekend_staged",
              sessionValidated: false,
              asOfSession: lastCompletedMarketSession(marketScope),
            } : undefined,
          ),
          PER_SYMBOL_TIMEOUT_MS,
          entry.symbol,
        );
      } catch (e) {
        results[i] = { symbol: entry.symbol, error: e instanceof Error ? e.message : String(e) };
      }
    }
  }
  const workerCount = Math.min(concurrency, entries.length);
  // Reserve one existing worker for candidates so a large live+paper book cannot
  // consume every wall-clock slot. This does not raise concurrency or provider
  // quota; remaining workers still prioritize the staleness-ordered holdings.
  const workerPreferences: Array<"holding" | "candidate"> = Array.from(
    { length: workerCount },
    (_, i) => i === 0 && candidateIndexes.length > 0 ? "candidate" : "holding",
  );
  await Promise.all(workerPreferences.map(worker));

  // Re-defer anything the budget didn't reach (results[i] still empty) so it
  // rotates to the FRONT of next run's queue instead of silently waiting.
  const deferred = entries.filter((_, i) => results[i] == null).map((e) => e.symbol);
  // Provenance travels with the deferred tail. Without it a screener candidate
  // cut by the budget returns as a generic "watchlist" name and its discovery
  // attribution is lost, which is what made screener-sourced decisions read ~0.
  const entrySourceOf = new Map<string, string | null | undefined>(
    entries.map((e) => [e.symbol, (e as any).discovery_source]),
  );
  if (deferred.length > 0) {
    const usDef = deferred.filter((s) => !isIndia(s));
    const inDef = deferred.filter((s) => isIndia(s));
    if (usDef.length) await enqueueDeferred(supabase, "us", usDef, entrySourceOf);
    if (inDef.length) await enqueueDeferred(supabase, "india", inDef, entrySourceOf);
  }

  // A deferred HOLDING is categorically worse than a deferred candidate: the
  // owner holds it, so a missed re-score means no SELL/exit signal can fire on a
  // position that may need one. This was previously invisible — the budget cut
  // holdings silently and the run still reported "done" (prod run a4530e8f:
  // 26 holdings unscored, status done, no alert). Holdings are staleness-ordered
  // so the same names can't starve forever, but the capacity shortfall itself
  // must be visible: enqueueDeferred canNOT rescue a holding (gatherSymbols
  // rebuilds holdings from the broker snapshot, and addCandidate drops any
  // symbol already in holdingSet), so this alert is the only signal that the
  // book is bigger than one run can score.
  const deferredHoldings = entries.filter((e, i) => results[i] == null && e.isHeld).map((e) => e.symbol);
  const deferredHoldingsKey = `research-deferred-holdings:${runTag}`;
  if (deferredHoldings.length > 0) {
    await emitAlert({
      issue_key: deferredHoldingsKey,
      severity: "warn",
      category: "cron",
      title: `Research: ${deferredHoldings.length} held position${deferredHoldings.length > 1 ? "s" : ""} not re-scored (budget)`,
      detail: `The wall-clock budget (${BUDGET_MS}ms) ran out before these HELD symbols were scored, so no exit/SELL signal was evaluated on them this run: ${deferredHoldings.join(", ")}. They are ordered least-recently-scored-first, so they lead the next run. If this fires every day the book (${entries.filter(e => e.isHeld).length} holdings) is larger than one run's throughput — raise RESEARCH_PARALLEL or split holdings into their own run.`,
      auto_expire_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    });
  } else if (!discoveryOnly) {
    // Capacity recovered — clear it. Without this the alert stays open forever
    // and the next real shortfall is indistinguishable from last week's.
    //
    // Guarded on `!discoveryOnly`: a discovery run carries no holdings by
    // construction, so resolving here would clear a real shortfall the main run
    // had just raised — an alert silenced by a run that never looked.
    await resolveIssue(deferredHoldingsKey, supabase);
  }

  // Closes a blind spot in `discovery-starved:us`. That alert fires when the
  // screener RETURNS nothing; it cannot see the case where the screener returns
  // candidates and the wall-clock budget then scores none of them. Both end with
  // zero screener-sourced decisions and only holdings/watchlist names in the
  // ledger — the same closed loop the alert exists to catch — but only one of
  // them raises it, so a healthy provider and a starved funnel look identical.
  //
  // Kept as a SEPARATE key rather than reusing discovery-starved:us: the two
  // have different remedies (provider vs throughput), and two writers on one
  // key would fight, one resolving what the other just raised.
  const screenerIdx = entries
    .map((e, i) => (String((e as any).discovery_source ?? "").startsWith("screener_") ? i : -1))
    .filter((i) => i >= 0);
  const screenerEntries = screenerIdx.map((i) => entries[i]);
  const screenerScored = screenerIdx.filter((i) => results[i] != null).length;
  const screenerDeferredKey = `research-deferred-screener:${runTag}`;
  if (screenerEntries.length > 0 && screenerScored === 0) {
    await emitAlert({
      issue_key: screenerDeferredKey,
      severity: "warn",
      category: "cron",
      title: `Research: all ${screenerEntries.length} screener candidate${screenerEntries.length > 1 ? "s were" : " was"} deferred (budget)`,
      detail: `The screener returned ${screenerEntries.length} candidate(s) — ${screenerEntries.map((e) => e.symbol).join(", ")} — and the wall-clock budget (${BUDGET_MS}ms) scored none of them. Discovery is working but its output is not reaching the evidence ledger, so this run only recorded names already held or watched. Candidates are re-deferred to the front of the next queue, but if this repeats the batch is larger than one run's throughput: raise RESEARCH_PARALLEL, or score screener candidates before the watchlist tail.`,
      auto_expire_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    });
  } else if (screenerScored > 0) {
    // Only clear when candidates actually got scored. A run with no screener
    // candidates at all is `discovery-starved:us`'s business, not this alert's —
    // resolving here would mark the throughput problem fixed by an empty funnel.
    await resolveIssue(screenerDeferredKey, supabase);
  }

  // results may now contain empty slots (symbols deferred by the wall-clock
  // budget) — guard every filter against null so they don't count as errors.
  const ok = results.filter(r => r && !r.error).length;
  const errs = results.filter(r => r && r.error).length;
  const processed = ok + errs;
  const completedCandidates = entries
    .filter((entry, i) => !entry.isHeld && results[i] && !results[i].error)
    .map(entry => entry.symbol);
  const failedCandidates = entries
    .filter((entry, i) => !entry.isHeld && results[i]?.error)
    .map(entry => entry.symbol);
  const failedDetails = results
    .filter(r => r && r.error)
    .slice(0, 10)
    .map(r => ({ symbol: String(r.symbol), reason: sanitizeResearchError(r.error) }));
  for (const queueMarket of ["us", "india"] as const) {
    const isQueueMarket = (symbol: string) => (queueMarket === "india") === isIndia(symbol);
    const completed = completedCandidates.filter(isQueueMarket);
    const failed = failedCandidates.filter(isQueueMarket);
    if (completed.length > 0) await completeDeferred(supabase, queueMarket, completed);
    if (failed.length > 0) await enqueueDeferred(supabase, queueMarket, failed, entrySourceOf);
  }

  // Cross-sectional rank — Pass 2 (features/cross-sectional-rank). Deterministic,
  // no LLM. Replaces the earlier naive mixed-pool percentile with a GROUPED rank
  // over the ELIGIBLE pool (data-quality gates run first), partitioned into
  // comparable groups (market × asset-type × sector) via the shared
  // computeComparableRank(). Persists richer provenance to
  // universe_snapshot_scores, then applies the hybrid floor-AND-rank entry gate
  // to agent_signals — but ONLY when the champion genome carries
  // entry.rank_pct_min > 0. Default 0.0 ⇒ zero agent_signals writes ⇒ selection
  // is byte-identical to pre-feature behavior. Fail-soft throughout.
  if (universeSnapshotId && !closedDayCatchup) {
    try {
      // Pair each non-error result with its source entry (same index) so we have
      // isHeld / asset-type / market alongside the score + observation id.
      const scored: { entry: (typeof entries)[number]; symbol: string; score: number; direction: string; obsId: number | null }[] = [];
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (!r || r.error || typeof r.analystScore !== "number") continue;
        scored.push({
          entry: entries[i],
          symbol: r.symbol as string,
          score: r.analystScore as number,
          direction: (r.direction as string) ?? "neutral",
          obsId: (r.obsId ?? null) as number | null,
        });
      }

      if (scored.length > 0) {
        // Read sector + evidence_confidence for this run's observations (already
        // written in Pass 1 — a DB read of our own rows, never an external fetch).
        const obsIds = scored.map(s => s.obsId).filter((x): x is number => typeof x === "number");
        const obsMeta = new Map<number, { sector: string | null; evidenceConfidence: number | null }>();
        if (obsIds.length > 0) {
          const { data: obsRows } = await supabase
            .from("decision_observations")
            .select("id, evidence_confidence, features")
            .in("id", obsIds);
          for (const row of (obsRows ?? []) as any[]) {
            const sector = row?.features?.fundamental?.sector ?? null;
            obsMeta.set(row.id, {
              sector: typeof sector === "string" && sector.trim() ? sector : null,
              evidenceConfidence: typeof row?.evidence_confidence === "number" ? row.evidence_confidence : null,
            });
          }
        }

        const candidates: RankCandidate[] = scored.map(s => {
          const meta = s.obsId != null ? obsMeta.get(s.obsId) : undefined;
          return {
            symbol: s.symbol,
            analystScore: s.score,
            market: isIndia(s.symbol) ? "india" : "us",
            assetType: s.entry.isEtf ? "etf" : "equity",
            sector: meta?.sector ?? null,
            evidenceConfidence: meta?.evidenceConfidence ?? null,
            direction: s.direction,
            isHeld: s.entry.isHeld,
          };
        });

        const ranked = computeComparableRank(candidates);
        const rankBySymbol = new Map(ranked.map(r => [r.symbol, r]));

        // Persist grouped rank provenance. New columns (rank_quality,
        // comparable_group_key, group_n, rank_eligible) are additive; on a
        // pre-151 schema the insert falls back to the base columns only.
        const scoreBySymbol = new Map(scored.map(s => [s.symbol, s]));
        const rankRows = ranked.map(r => ({
          universe_snapshot_id: universeSnapshotId,
          symbol: r.symbol,
          analyst_score: scoreBySymbol.get(r.symbol)?.score ?? null,
          rank_pct: r.rank_pct,
          decision_observation_id: scoreBySymbol.get(r.symbol)?.obsId ?? null,
          rank_quality: r.rank_quality,
          comparable_group_key: r.comparable_group_key,
          group_n: r.group_n,
          rank_eligible: r.rank_eligible,
        }));
        const { error: usErr } = await supabase.from("universe_snapshot_scores").insert(rankRows);
        if (usErr && ["42703", "PGRST204"].includes(String(usErr.code ?? ""))) {
          // pre-151 schema: retry with only the original columns so measure-only
          // logging still lands.
          const baseRows = rankRows.map(({ rank_quality, comparable_group_key, group_n, rank_eligible, ...base }) => base);
          await supabase.from("universe_snapshot_scores").insert(baseRows);
        }

        // Hybrid entry gate (features/cross-sectional-rank §5). Read the champion
        // genome's rank_pct_min per market — default 0.0 ⇒ gate inactive ⇒ we do
        // NOT touch agent_signals at all, so daily selection is unchanged.
        const gateMarket = marketScope ?? "us";
        let rankPctMin = 0;
        try {
          const scoped = await supabase.from("strategy_versions").select("genome")
            .eq("is_champion", true).eq("market", gateMarket).limit(1).maybeSingle();
          let champGenome = (scoped.data as any)?.genome;
          if (!champGenome) {
            const legacy = await supabase.from("strategy_versions").select("genome")
              .eq("is_champion", true).order("promoted_at", { ascending: false }).limit(1).maybeSingle();
            champGenome = (legacy.data as any)?.genome;
          }
          const v = champGenome?.entry?.rank_pct_min;
          if (typeof v === "number" && v > 0) rankPctMin = v;
        } catch { /* no champion / pre-genome schema → gate stays off */ }

        if (rankPctMin > 0) {
          // A NEW long is rejected when it fails §4.1 (not rank-eligible) OR its
          // within-group percentile is below the floor. This can only REMOVE
          // candidates (actionable set ⊆ absolute-floor survivors); the ≤3/day
          // cap, long-only rule, and held-position SELL path are untouched.
          for (const s of scored) {
            if (s.entry.isHeld) continue;          // holdings' exits never gated
            if (s.direction !== "long") continue;  // only long entries considered
            const r = rankBySymbol.get(s.symbol);
            if (!isRankRejected(r, rankPctMin)) continue;
            const mkt = isIndia(s.symbol) ? "india" : "us";
            try {
              await supabase.from("agent_signals")
                .update({ rank_pct: r?.rank_pct ?? null, rank_rejected: true, status: "rank_rejected" })
                .eq("symbol", s.symbol).eq("market", mkt)
                .eq("status", "pending").eq("direction", "long");
            } catch (e) {
              console.error("[research-cron] rank-gate agent_signals update failed (non-blocking):", e instanceof Error ? e.message : e);
            }
          }
        }
      }
    } catch (e) {
      console.error("[research-cron] cross-sectional rank (Pass 2) failed (non-blocking):", e instanceof Error ? e.message : e);
    }
  }

  if (runId) {
    const holdingProcessed = entries.filter((entry, i) => entry.isHeld && results[i] && !results[i].error).length;
    const candidateProcessed = entries.filter((entry, i) => !entry.isHeld && results[i] && !results[i].error).length;
    // W6 run-accounting envelope — reconciles every entry under exactly one bucket
    // so stale-check can verify the job accounted for its own work.
    const accounting = runAccountingEnvelope({
      job: `research:${marketScope ?? "us"}${discoveryOnly ? ":discovery" : ""}`,
      market: (marketScope ?? "us") as "us" | "india",
      eligible: entries.length,
      succeeded: ok,
      expectedSkip: 0,
      deferred: deferred.length,
      unavailable: 0,
      failed: errs,
      businessMetrics: { signals: ok, holdings: holdingProcessed, candidates: candidateProcessed },
    });
    await supabase.from("agent_runs").update({
      status: "done",
      signals_written: ok,
      result_summary: `cron: ${ok} signals, ${errs} failed${deferred.length ? `, ${deferred.length} deferred (budget)` : ""} | ${batch.join(",")}`,
      workload_metrics: {
        mode: closedDayCatchup ? "closed_day_catchup" : "session",
        queue_depth_start: queueDepthAtStart,
        holding_processed: holdingProcessed,
        candidate_processed: candidateProcessed,
        deferred: deferred.length,
        failed_symbols: failedDetails,
        ...accounting,
      },
      completed_at: new Date().toISOString(),
    } as any).eq("id", runId);
  }

  // One durable issue per market: retries refresh it with current symbols and
  // useful reasons; the first clean run resolves it. This prevents a pile of
  // expiring duplicate warnings that cannot show whether the fault recovered.
  const failureIssueKey = `research-symbol-failures:${runTag}`;
  if (errs > 0) {
    const failureDetails = failedDetails.map(r => `${r.symbol}: ${r.reason}`).join("; ");
    await reportIssue({
      issueKey: failureIssueKey,
      severity: errs === processed ? "critical" : "warn",
      category: "cron",
      title: `Research: ${errs} symbol${errs > 1 ? "s" : ""} failed`,
      detail: `${failureDetails}. ${ok} succeeded; ${failedCandidates.length} failed candidate(s) queued for bounded retry.`,
      autoExpireAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
    }, supabase);
  } else {
    await resolveIssue(failureIssueKey, supabase);
  }

  // W3: refresh price_cache for researched symbols + benchmark ETFs.
  //
  // This was `prewarmPriceCache(...).catch(() => {})` — fired without await
  // immediately before the response. Unawaited work after a serverless response
  // is not a durable job: the runtime froze it mid-flight. It completed on
  // 2026-07-22 and never reliably again, leaving 101 of 140 price_cache symbols
  // stuck at that date. That stale cache is what PaperTrader then filled against
  // (15 US fills, errors to 19.6%) until W1 closed the quote gate.
  //
  // It is now AWAITED, and therefore bounded: research owns a 150s budget, so
  // the prewarm gets whatever remains minus a reserve for this response. Running
  // out of time is reported rather than hidden — a silent partial refresh is
  // exactly how the original freeze escaped notice for 25 days.
  const BENCHMARK_SYMBOLS = ["VOO", "QQQ", "SPY", "IWM", "XLK", "XLF", "XLE", "XLV", "XLI", "XLY", "XLC", "XLP", "XLU", "XLRE", "XLB"];

  // SCOPE MUST MATCH WHAT THE FRESHNESS CONTRACT DEMANDS.
  //
  // This used to be `batch + BENCHMARK_SYMBOLS` — only the symbols THIS run
  // scored. But `price-cache-us-symbols` requires freshness for every symbol
  // scored in the last 7 days plus every open position, so a name scored five
  // days ago and absent from today's batch was required fresh and refreshed by
  // nothing. Measured 2026-09-02: 17/113 scopes past grace, 85% coverage against
  // a 90% floor, and `quote_stale=7` blocked 7 of 10 eligible US candidates the
  // day before. The monitor and the refresher have to agree on scope or the gap
  // reopens every time the universe rotates.
  //
  // Widening is nearly free: prewarmPriceCache resolves freshness for the whole
  // set in one bulk query and only fetches what is genuinely stale, under the
  // same deadline. Ordering carries the budget policy (see resolvePrewarmScope).
  const prewarmMarket = marketScope ?? "us";
  let openPositionSymbols: string[] = [];
  let recentlyScoredSymbols: string[] = [];
  try {
    const decisionSince = new Date(Date.now() - PREWARM_RECENT_DECISION_DAYS * 86400_000).toISOString();
    const [positionRows, decisionRows] = await Promise.all([
      supabase.from("paper_positions").select("symbol")
        .eq("market", prewarmMarket).is("exit_reason", null).gt("qty", 0).limit(500),
      supabase.from("decision_observations").select("symbol")
        .eq("market", prewarmMarket).gte("ts", decisionSince).limit(5000),
    ]);
    openPositionSymbols = (positionRows.data ?? []).map((r: any) => String(r.symbol ?? ""));
    recentlyScoredSymbols = (decisionRows.data ?? []).map((r: any) => String(r.symbol ?? ""));
  } catch (e) {
    // Fail SOFT to the old scope: a wider prewarm is an improvement, not a
    // precondition. Losing it must never abort the research run.
    console.error(`[research:${runTag}] prewarm scope widening failed, falling back to batch:`, e instanceof Error ? e.message : e);
  }
  const prewarmSymbols = resolvePrewarmScope({
    batch,
    benchmarks: prewarmMarket === "us" ? BENCHMARK_SYMBOLS : [],
    openPositions: openPositionSymbols,
    recentlyScored: recentlyScoredSymbols,
  });
  const PREWARM_RESPONSE_RESERVE_MS = 5_000;
  const prewarmDeadline = routeStartedAt + (maxDuration * 1000) - PREWARM_RESPONSE_RESERVE_MS;

  let prewarm = { ok: 0, failed: 0, skipped: prewarmSymbols.length, alreadyFresh: 0 };
  try {
    prewarm = await prewarmPriceCache(prewarmSymbols, supabase, { deadlineAt: prewarmDeadline });
  } catch (e: any) {
    prewarm = { ok: 0, failed: prewarmSymbols.length, skipped: 0, alreadyFresh: 0 };
    console.error(`[research:${runTag}] price_cache prewarm threw:`, e?.message ?? e);
  }

  // Detector. A prewarm that cannot keep the traded universe fresh is a
  // money-path problem, not a cosmetic one — it is the precondition for a stale
  // fill. Surface it instead of returning success over a half-done refresh.
  const prewarmIssueKey = `price-cache-prewarm-incomplete:${runTag}`;
  const prewarmUnrefreshed = prewarm.failed + prewarm.skipped;
  if (prewarmUnrefreshed > 0) {
    await reportIssue({
      issueKey: prewarmIssueKey,
      severity: prewarm.ok === 0 ? "critical" : "warn",
      category: "data",
      title: `price_cache prewarm incomplete — ${prewarmUnrefreshed}/${prewarmSymbols.length} symbols not refreshed`,
      detail:
        `${prewarm.ok - prewarm.alreadyFresh} fetched, ${prewarm.alreadyFresh} already fresh, ` +
        `${prewarm.failed} failed, ${prewarm.skipped} skipped for time ` +
        `(deadline ${new Date(prewarmDeadline).toISOString()}). Symbols left unrefreshed keep serving their ` +
        `previous close, and a stale close is what W1's quote gate now REFUSES to fill against — so entries ` +
        `for those names will be declined rather than mispriced. Investigate provider budgets or raise the ` +
        `research budget if skipped is persistently high.`,
      autoExpireAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
    }, supabase);
  } else {
    await resolveIssue(prewarmIssueKey, supabase);
  }

  return NextResponse.json({
    success: true, mode: closedDayCatchup ? "closed_day_catchup" : "session",
    processed: results.length, ok, errors: errs, symbols: batch,
    price_cache_prewarm: { ...prewarm, requested: prewarmSymbols.length },
  });
}
