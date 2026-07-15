import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { gatherSymbols, processSymbol } from "@/lib/research-agent";
import { computeComparableRank, isRankRejected, type RankCandidate } from "@/lib/scoring/rank";
import { isIndia } from "@/lib/india-data";
import { enqueueDeferred } from "@/lib/research-queue";
import { prewarmPriceCache } from "@/lib/chart-data";
import { RISK_PROFILES } from "@/lib/risk-profiles";
import { verifyCronSecret } from "@/lib/auth/cron";
import { emitAlert } from "@/lib/alerts/emit";

export const dynamic = "force-dynamic";
// Bumped from 60 -> 150s: Theme Scout is now awaited inline (before
// gatherSymbols) instead of fired async, so its own AV/LLM round-trip now
// counts against this run's budget too.
export const maxDuration = 150;

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

  const mktParam = new URL(req.url).searchParams.get("market");
  const marketScope = mktParam === "india" ? "india" : mktParam === "us" ? "us" : null;

  const supabase = createServiceClient();

  // Skip on weekends (both markets closed Sat/Sun).
  const nowET = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const dayOfWeek = nowET.getDay(); // 0=Sun, 6=Sat
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return NextResponse.json({ skipped: true, reason: "Weekend — market closed" });
  }
  // US holiday calendar only gates US runs — an India run must not be skipped on
  // a US holiday (and vice versa).
  if (marketScope !== "india") {
    const mmdd = `${String(nowET.getMonth() + 1).padStart(2, "0")}-${String(nowET.getDate()).padStart(2, "0")}`;
    const US_HOLIDAYS = ["01-01","01-20","02-17","04-18","05-26","06-19","07-04","09-01","11-27","12-25"]; // 2026 approx
    if (US_HOLIDAYS.includes(mmdd)) {
      return NextResponse.json({ skipped: true, reason: `US market holiday (${mmdd})` });
    }
  }
  // NSE holiday calendar — FIXED-DATE holidays only (Republic Day, Independence
  // Day, Gandhi Jayanti). Floating festival holidays (Holi, Diwali, Eid, etc.)
  // are NOT modeled here — they shift yearly and guessing wrong dates is worse
  // than not gating at all. On an unmodeled NSE holiday this still fires and
  // produces stale/no data; a proper fix needs a verified annual NSE holiday
  // calendar (API or manually-updated list), not a guess.
  if (marketScope === "india") {
    const nowIST = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const mmddIST = `${String(nowIST.getMonth() + 1).padStart(2, "0")}-${String(nowIST.getDate()).padStart(2, "0")}`;
    const NSE_FIXED_HOLIDAYS = ["01-26", "08-15", "10-02"]; // Republic Day, Independence Day, Gandhi Jayanti
    if (NSE_FIXED_HOLIDAYS.includes(mmddIST)) {
      return NextResponse.json({ skipped: true, reason: `NSE fixed-date holiday (${mmddIST})` });
    }
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
  // the India run, and vice-versa. agent_runs has no market column, so infer each
  // recent run's market from its symbols (any .NS/.BO → India) and only block when
  // a run for THIS market is in the window.
  const guardWindow = new Date(Date.now() - 30 * 60_000).toISOString();
  const { data: recentRuns } = await supabase
    .from("agent_runs")
    .select("id, status, started_at, symbols")
    .eq("agent_type", "research")
    .gte("started_at", guardWindow)
    .order("started_at", { ascending: false })
    .limit(5);
  const runMarket = (r: any): string =>
    (Array.isArray(r?.symbols) && r.symbols.some((s: string) => /\.(NS|BO)$/i.test(String(s)))) ? "india" : "us";
  const guardMarket = marketScope ?? "us";
  const recentRun = (recentRuns ?? []).find((r: any) => runMarket(r) === guardMarket);
  if (recentRun) {
    return NextResponse.json({
      skipped: true,
      reason: `Research (${guardMarket}) already ran (or is running) within the last 30 minutes — run ${(recentRun as any).id} started at ${(recentRun as any).started_at}`,
    });
  }

  // Theme Scout runs (and is awaited) BEFORE gatherSymbols so today's newly
  // discovered theme tickers land in the watchlist in time to be researched
  // THIS run, not tomorrow's. US-only (theme-scout has no India logic) — skip
  // on an India-scoped run so it doesn't fire twice a day.
  if (marketScope !== "india") {
    const appUrlEarly = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    try {
      const tsRes = await fetch(`${appUrlEarly}/api/agents/theme-scout`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-cron-secret": process.env.CRON_SECRET ?? "" },
        signal: AbortSignal.timeout(45000),
      });
      if (!tsRes.ok) console.error(`[research-cron] Theme Scout failed inline (${tsRes.status}) — proceeding without today's new theme picks`);
    } catch (e) {
      // Fail-soft — a Theme Scout hiccup must never block research — but
      // silent failure here previously left zero signal that "0 signals
      // written" or a slow run was actually caused by Theme Scout timing out.
      console.error("[research-cron] Theme Scout timed out or errored inline — proceeding without today's new theme picks:", e instanceof Error ? e.message : e);
    }
  }

  const allEntries = await gatherSymbols(supabase);
  // Scope to the requested market: India run researches only .NS/.BO names; US run
  // only non-India. No param → everything (legacy).
  const entries = marketScope === "india" ? allEntries.filter(e => isIndia(e.symbol))
    : marketScope === "us" ? allEntries.filter(e => !isIndia(e.symbol))
    : allEntries;
  const batch = entries.map(e => e.symbol);

  if (entries.length === 0) {
    return NextResponse.json({ skipped: true, reason: `No ${marketScope ?? "any"}-market symbols to research (check market_focus).` });
  }

  const { data: runRow } = await supabase.from("agent_runs").insert({
    agent_type: "research",
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
  let idx = 0;
  async function worker() {
    while (idx < entries.length && Date.now() < processingDeadline) {
      const i = idx++;
      const entry = entries[i];
      try {
        results[i] = await processSymbol(entry, supabase, universeSnapshotId, runId ? String(runId) : null);
      } catch (e) {
        results[i] = { symbol: entry.symbol, error: e instanceof Error ? e.message : String(e) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));

  // Re-defer anything the budget didn't reach (results[i] still empty) so it
  // rotates to the FRONT of next run's queue instead of silently waiting.
  const deferred = entries.filter((_, i) => results[i] == null).map((e) => e.symbol);
  if (deferred.length > 0) {
    const usDef = deferred.filter((s) => !isIndia(s));
    const inDef = deferred.filter((s) => isIndia(s));
    if (usDef.length) await enqueueDeferred(supabase, "us", usDef);
    if (inDef.length) await enqueueDeferred(supabase, "india", inDef);
  }

  // results may now contain empty slots (symbols deferred by the wall-clock
  // budget) — guard every filter against null so they don't count as errors.
  const ok = results.filter(r => r && !r.error).length;
  const errs = results.filter(r => r && r.error).length;
  const processed = ok + errs;

  // Cross-sectional rank — Pass 2 (features/cross-sectional-rank). Deterministic,
  // no LLM. Replaces the earlier naive mixed-pool percentile with a GROUPED rank
  // over the ELIGIBLE pool (data-quality gates run first), partitioned into
  // comparable groups (market × asset-type × sector) via the shared
  // computeComparableRank(). Persists richer provenance to
  // universe_snapshot_scores, then applies the hybrid floor-AND-rank entry gate
  // to agent_signals — but ONLY when the champion genome carries
  // entry.rank_pct_min > 0. Default 0.0 ⇒ zero agent_signals writes ⇒ selection
  // is byte-identical to pre-feature behavior. Fail-soft throughout.
  if (universeSnapshotId) {
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
    await supabase.from("agent_runs").update({
      status: "done",
      signals_written: ok,
      result_summary: `cron: ${ok} signals, ${errs} failed${deferred.length ? `, ${deferred.length} deferred (budget)` : ""} | ${batch.join(",")}`,
      completed_at: new Date().toISOString(),
    } as any).eq("id", runId);
  }

  // Emit alerts for failures
  if (errs > 0) {
    const failedSymbols = results.filter(r => r && r.error).map(r => r.symbol).join(", ");
    await emitAlert({
      severity: errs === processed ? "error" : "warn",
      category: "cron",
      title: `Research: ${errs} symbol${errs > 1 ? "s" : ""} failed`,
      detail: `Failed: ${failedSymbols}. ${ok} succeeded.`,
      auto_expire_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    });
  }
  if (ok === 0 && processed > 0) {
    await emitAlert({
      severity: "error",
      category: "cron",
      title: "Research cron produced 0 signals",
      detail: `Attempted ${processed} symbols, all failed; ${deferred.length} were deferred without being attempted. Check LLM keys and data APIs.`,
      auto_expire_at: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
    });
  }

  // Chain PaperTrader automatically after research completes — same market scope
  // so an India research run fills the ₹ pool, a US run the $ pool.
  let paperTradeResult: any = null;
  try {
    const ptUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/agents/paper-trade${marketScope ? `?market=${marketScope}` : ""}`;
    const ptRes = await fetch(ptUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Service-to-service: pass cron secret so paper-trade can skip user auth if needed
        "x-cron-secret": process.env.CRON_SECRET ?? "",
      },
    });
    paperTradeResult = await ptRes.json();
  } catch (e) {
    paperTradeResult = { error: e instanceof Error ? e.message : String(e) };
  }

  // Pre-warm price_cache for researched symbols + benchmark ETFs (fire async, don't block response)
  const BENCHMARK_SYMBOLS = ["VOO", "QQQ", "SPY", "IWM", "XLK", "XLF", "XLE", "XLV", "XLI", "XLY", "XLC", "XLP", "XLU", "XLRE", "XLB"];
  const prewarmSymbols = [...new Set([...batch, ...BENCHMARK_SYMBOLS])];
  prewarmPriceCache(prewarmSymbols, supabase).catch(() => {});

  return NextResponse.json({
    success: true, processed: results.length, ok, errors: errs, symbols: batch,
    paperTrade: paperTradeResult,
  });
}
