import { NextRequest, NextResponse } from "next/server";
import { loadTradingMandate } from "@/lib/trading-mandate";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchQuote } from "@/lib/market-data";
import { runAgentLoop, ToolCall } from "@/lib/llm-router";
import { loadLabeledDataset } from "@/lib/learning/dataset";
import { validateFeatureInputs } from "@/lib/validation/feature-compiler";
import { verifyCronSecret } from "@/lib/auth/cron";
import { indexClosedTrade } from "@/lib/rag/trade-memory";
import { applyLearningTaintFilter } from "@/lib/learning/taint-filter";
import { runAutomatedValidation } from "@/lib/validation/automation";
import { fetchIndiaQuote } from "@/lib/india-data";

export const dynamic = "force-dynamic";
// The weekly tool loop can legitimately take several provider round-trips.
// Keep the route below Vercel's 300s ceiling and align pg_net timeouts with it.
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const isCron = verifyCronSecret(req);
    if (!isCron) {
      const userClient = await createClient();
      const { data: { user } } = await userClient.auth.getUser();
      if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Cron-triggered learner runs WEEKLY on Fridays only.
    // Manual triggers (from AgentsPage) run any day.
    const nowET = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    const dow = nowET.getDay(); // 0=Sun, 5=Fri, 6=Sat
    if (isCron && (dow === 0 || dow === 6)) {
      return NextResponse.json({ skipped: true, reason: "Weekend — learner runs Fridays only" });
    }
    if (isCron && dow !== 5) {
      return NextResponse.json({ skipped: true, reason: `Learner is weekly — runs Fridays only (today is day ${dow})` });
    }

    const svc = createServiceClient();

    // Phase 4 (multi-market): the learner analyzes ONE market's cohort per run
    // and proposes weights ONLY for that market's champion — so a bad India run
    // can never shift US scoring. Default to US (the only market with closed-trade
    // history today); India gets its own cohort + champion once it clears the same
    // 10+ closed-trade phase gate. `hasMarketCol` gates all market filters so this
    // degrades to the old US-only behavior pre-057.
    // Market is a per-run parameter (body { market } or ?market=), so India can
    // evolve its own champion on its own cron/manual trigger. Defaults to US.
    // Still ONE market per run — a bad India run never shifts US scoring.
    let reqMarket: "us" | "india" = "us";
    try {
      const body = await req.clone().json();
      if (body?.market === "india") reqMarket = "india";
    } catch { /* no body */ }
    if (new URL(req.url).searchParams.get("market") === "india") reqMarket = "india";
    const LEARN_MARKET: "us" | "india" = reqMarket;
    let hasMarketCol = true;
    { const { error } = await svc.from("paper_trades").select("market").limit(1); hasMarketCol = !error; }
    const scopeMkt = (q: any) => (hasMarketCol ? q.eq("market", LEARN_MARKET) : q);

    // Idempotency guard — LearnerAgent is documented (and scheduled) as a weekly
    // batch job. Even manual triggers (allowed any day from AgentsPage) should not
    // silently stack multiple runs on the same day — that's how one day ends up
    // with 4 learner runs. Skip if a run already exists for today's date, unless
    // the caller explicitly passes { force: true } to intentionally re-run.
    let forceRerun = false;
    try {
      const body = await req.clone().json();
      forceRerun = body?.force === true;
    } catch { /* no/invalid body — default to not forcing */ }

    if (!forceRerun) {
      const todayStr = new Date().toISOString().slice(0, 10);
      const dayStart = `${todayStr}T00:00:00.000Z`;
      // Scope the idempotency guard to THIS market so a US run doesn't block
      // the same day's India run (and vice versa).
      const { data: todaysRun } = await svc
        .from("agent_runs")
        .select("id, status, started_at, trigger_source")
        .eq("agent_type", "learner")
        .eq("market", LEARN_MARKET)
        .gte("started_at", dayStart)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (todaysRun) {
        return NextResponse.json({
          skipped: true,
          reason: `Learner already ran today for ${LEARN_MARKET.toUpperCase()} (run ${(todaysRun as any).id}, ${(todaysRun as any).trigger_source} at ${(todaysRun as any).started_at}). Pass { force: true } to re-run.`,
        });
      }
    }

    const { data: runRow } = await svc.from("agent_runs").insert({
      agent_type: "learner", status: "running",
      trigger_source: isCron ? "scheduled" : "manual",
      market: LEARN_MARKET,
    } as any).select().single();
    const runId = (runRow as any)?.id ?? null;

    // Open-position exits and target evolution belong exclusively to the daily
    // PositionMonitor. LearnerAgent observes closed outcomes and proposes
    // challengers; it never mutates an open paper position.
    const positionReassessments: string[] = [];

    // Reconciliation only — LearnerAgent no longer force-sells live positions on
    // a timer. That old behavior (close any trade >N days old on a crude
    // pnl>$0.50 win/loss) was wrong: it dumped positions that were still scoring
    // well purely because time had passed, contradicting the "hold while the AI
    // score stays above threshold" model. Exits are now fully owned by
    // PositionMonitor (daily): score-based exit when conviction drops below the
    // exit threshold, plus trailing-stop and price-target — all using a live
    // price, checked every trading day, so nothing goes stale-unchecked.
    //
    // This sweep now only closes TRUE ORPHANS: an open paper_trades row whose
    // paper_positions row no longer exists (the position was already exited but
    // the trade row dangles). It never touches a trade whose position is still
    // open — that's a live holding the daily monitor manages.
    const cutoff = new Date(Date.now() - 14 * 86400_000).toISOString();
    const { data: openTrades } = await scopeMkt(svc.from("paper_trades").select("*").is("closed_at", null).lt("executed_at", cutoff));

    const outcomes: any[] = [];
    const priceFailures: string[] = [];

    for (const trade of openTrades ?? []) {
      // Only reconcile orphans — if a position still exists for this symbol,
      // it's a live holding managed by PositionMonitor; leave it alone.
      const { data: livePos } = await scopeMkt(svc.from("paper_positions")
        .select("id").eq("symbol", trade.symbol)).maybeSingle();
      if (livePos) continue;

      const quote = LEARN_MARKET === "india"
        ? await fetchIndiaQuote(trade.symbol)
        : await fetchQuote(trade.symbol);
      if (!quote || ("source" in quote && quote.source === "unavailable") || quote.price <= 0) { priceFailures.push(trade.symbol); continue; }

      const exitPrice = quote.price;
      const pnl = (exitPrice - trade.fill_price) * trade.qty;
      const pnlPct = ((exitPrice - trade.fill_price) / trade.fill_price) * 100;
      const outcome = pnl > 0.5 ? "win" : pnl < -0.5 ? "loss" : "breakeven";

      // Close the dangling trade row. Do NOT credit cash again — the position
      // that this trade belonged to was already closed by PositionMonitor, which
      // already credited the proceeds. Double-crediting here would inflate NAV.
      await svc.from("paper_trades").update({ exit_price: exitPrice, realized_pnl: pnl, pnl_pct: pnlPct, outcome, closed_at: new Date().toISOString() }).eq("id", trade.id);
      // Index the now-closed orphan into RAG memory (Tier-3 #10). Best-effort.
      await indexClosedTrade(String(trade.id)).catch(() => {});

      outcomes.push({ symbol: trade.symbol, outcome, pnl, pnlPct, exitPrice, reconciled_orphan: true });
    }

    // ── Phase B: Load context for agent ──────────────────────────────────────
    const [
      { data: agentCfg },
      { data: existingRun },
      { count: totalClosedTrades },
      { data: learnerConfig },
      { data: recentRuns },
    ] = await Promise.all([
      svc.from("agent_config").select("model, enabled").eq("agent_name", "learner").single(),
      svc.from("learner_runs").select("id").eq("run_date", new Date().toISOString().slice(0, 10)).eq("market", LEARN_MARKET).maybeSingle(),
      scopeMkt(svc.from("paper_trades").select("*", { count: "exact", head: true }).not("closed_at", "is", null)),
      svc.from("learner_config").select("*"),
      svc.from("learner_runs").select("win_rate_snapshot, mutations_paused, run_date").eq("market", LEARN_MARKET).order("run_date", { ascending: false }).limit(5),
    ]);

    // Fallback must be a model this app can actually route. `claude-opus-4-8` was
    // left here after execClaude was deleted — nothing can serve an Anthropic id
    // any more, so a missing agent_config row would have failed the whole learner
    // run instead of degrading. Only the prod DB row (deepseek-reasoner) kept Opus
    // out of the tool loop. Match the row's own family so config-missing behaves
    // like config-present.
    const agentModel = (agentCfg as any)?.model ?? "deepseek-reasoner";
    const agentEnabled = (agentCfg as any)?.enabled ?? true;
    const today = new Date().toISOString().slice(0, 10);

    // Build dimension config map
    const dimConfig: Record<string, any> = {};
    for (const cfg of learnerConfig ?? []) {
      dimConfig[(cfg as any).dimension] = cfg;
    }

    // Phase 3 governance rewiring: auto-guard is now CHAMPION HEALTH, not a raw
    // win-rate streak (win-rate ignores payoff asymmetry and doesn't reflect
    // actual risk). Trips (blocks update_signal_weight LIVE proposals only —
    // hypothesis writing, validation, and shadow research are unaffected) on
    // ANY of: (a) drawdown > 15% from the market's 90d NAV peak, (b) pwin
    // calibration drift (max |predicted-realized| gap across deciles > 0.25),
    // (c) data-availability < 60% over the last 10 decision_observations.
    let autoGuardTripped = false;
    let autoGuardReason = "OK";
    try {
      const since90 = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);
      const { data: perfRows } = await svc.from("paper_performance").select("nav, date").eq("market", LEARN_MARKET).gte("date", since90).order("date", { ascending: true });
      if (perfRows && perfRows.length > 0) {
        const navs = perfRows.map((r: any) => Number(r.nav)).filter(Number.isFinite);
        const peak = Math.max(...navs);
        const current = navs[navs.length - 1];
        const drawdownPct = peak > 0 ? ((peak - current) / peak) * 100 : 0;
        if (drawdownPct > 15) { autoGuardTripped = true; autoGuardReason = `drawdown ${drawdownPct.toFixed(1)}% > 15% from 90d peak`; }
      }
      if (!autoGuardTripped) {
        const { data: modelRow } = await svc.from("model_artifacts").select("calibration").eq("market", LEARN_MARKET).eq("kind", "pwin_logistic").maybeSingle();
        const deciles = (modelRow as any)?.calibration ?? [];
        const maxGap = deciles.reduce((m: number, d: any) => Math.max(m, Math.abs((d.predictedMean ?? 0) - (d.realizedWinRate ?? 0))), 0);
        if (deciles.length > 0 && maxGap > 0.25) { autoGuardTripped = true; autoGuardReason = `calibration drift: max decile gap ${maxGap.toFixed(2)} > 0.25`; }
      }
      if (!autoGuardTripped) {
        const { data: recentObs } = await svc.from("decision_observations").select("availability_mask").eq("market", LEARN_MARKET).order("ts", { ascending: false }).limit(10);
        if (recentObs && recentObs.length >= 10) {
          const avail = recentObs.map((r: any) => {
            const m = r.availability_mask ?? {};
            const flags = Object.values(m);
            return flags.length ? flags.filter(Boolean).length / flags.length : 1;
          });
          const avgAvail = avail.reduce((a: number, b: number) => a + b, 0) / avail.length;
          if (avgAvail < 0.60) { autoGuardTripped = true; autoGuardReason = `data availability ${(avgAvail * 100).toFixed(0)}% < 60% over last 10 observations`; }
        }
      }
    } catch { /* resilient — absent tables/columns (pre-Phase-2/3) just mean the guard can't trip yet */ }

    let learnerResult: any = null;

    if (agentEnabled && !existingRun) {
      const { count: signalCount } = await svc.from("agent_signals").select("*", { count: "exact", head: true });

      // ── Tool implementations ────────────────────────────────────────────────

      // Shared by query_score_correlation (read-only diagnostic tool) AND
      // update_signal_weight (the actual gate). Previously update_signal_weight
      // trusted the LLM's OWN n_trades/confidence arguments for its numeric
      // gates — the LLM could claim n_trades:10 with a stronger correlation than
      // what query_score_correlation actually returned, since nothing bound the
      // mutation to a specific correlation result. This recomputes the same
      // correlation server-side so the gate is checked against ground truth,
      // not LLM-reported numbers.
      async function computeScoreCorrelation(dimension: string, days = 60): Promise<{ source: "observation_ledger" | "paper_trades_fallback" | "insufficient_data"; n: number; correlation: number }> {
        const since = new Date(Date.now() - days * 86400_000).toISOString();
        try {
          const ledgerRows = await loadLabeledDataset(svc, LEARN_MARKET, 10);
          if (ledgerRows.length >= 10) {
            const ledgerPairs = ledgerRows
              .map(r => ({ score: (r as any)[dimension] as number | null, pnl: r.benchmark_neutral_return ?? r.fwd_return }))
              .filter(p => p.score != null && p.pnl != null) as { score: number; pnl: number }[];
            if (ledgerPairs.length >= 10) {
              const n = ledgerPairs.length;
              const meanScore = ledgerPairs.reduce((a, b) => a + b.score, 0) / n;
              const meanPnl = ledgerPairs.reduce((a, b) => a + b.pnl, 0) / n;
              const num = ledgerPairs.reduce((a, b) => a + (b.score - meanScore) * (b.pnl - meanPnl), 0);
              const denScore = Math.sqrt(ledgerPairs.reduce((a, b) => a + Math.pow(b.score - meanScore, 2), 0));
              const denPnl = Math.sqrt(ledgerPairs.reduce((a, b) => a + Math.pow(b.pnl - meanPnl, 2), 0));
              const correlation = denScore * denPnl === 0 ? 0 : parseFloat((num / (denScore * denPnl)).toFixed(3));
              return { source: "observation_ledger", n, correlation };
            }
          }
        } catch { /* ledger unavailable (059/060 not applied) — fall through to legacy path */ }

        const { data: signals } = await scopeMkt(svc.from("agent_signals")
          .select(`id, ${dimension}, created_at`)
          .gte("created_at", since).not(dimension, "is", null).limit(100));
        const { data: trades } = await scopeMkt(applyLearningTaintFilter(svc.from("paper_trades")
          .select("signal_id, pnl_pct, executed_at")
          .not("closed_at", "is", null).gte("executed_at", since)));

        const tradeMap = new Map<any, number | null>((trades ?? []).map((t: any) => [t.signal_id, t.pnl_pct as number | null]));
        const pairs: { score: number; pnl: number }[] = [];
        for (const s of signals ?? []) {
          const pnl = tradeMap.get((s as any).id);
          const score = (s as any)[dimension];
          if (pnl != null && score != null) pairs.push({ score, pnl: pnl as number });
        }
        if (pairs.length < 3) return { source: "insufficient_data", n: pairs.length, correlation: 0 };

        const n = pairs.length;
        const meanScore = pairs.reduce((a, b) => a + b.score, 0) / n;
        const meanPnl = pairs.reduce((a, b) => a + b.pnl, 0) / n;
        const num = pairs.reduce((a, b) => a + (b.score - meanScore) * (b.pnl - meanPnl), 0);
        const denScore = Math.sqrt(pairs.reduce((a, b) => a + Math.pow(b.score - meanScore, 2), 0));
        const denPnl = Math.sqrt(pairs.reduce((a, b) => a + Math.pow(b.pnl - meanPnl, 2), 0));
        const correlation = denScore * denPnl === 0 ? 0 : parseFloat((num / (denScore * denPnl)).toFixed(3));
        return { source: "paper_trades_fallback", n, correlation };
      }

      async function toolExecutor(call: ToolCall): Promise<string> {
        switch (call.name) {

          case "query_signals_with_outcomes": {
            const days = (call.arguments.days as number) ?? 30;
            const minScore = (call.arguments.min_analyst_score as number) ?? 0;
            const assetClass = call.arguments.asset_class as string | undefined;
            const since = new Date(Date.now() - days * 86400_000).toISOString();

            let query = scopeMkt(svc.from("agent_signals")
              .select("id, symbol, direction, analyst_score, fundamental_score, technical_score, sentiment_score, macro_score, insider_score, created_at, source, asset_class")
              .gte("created_at", since)
              .gte("analyst_score", minScore)
              .order("created_at", { ascending: false })
              .limit(100));
            if (assetClass) query = (query as any).eq("asset_class", assetClass);

            const { data: signals } = await query;
            const { data: trades } = await scopeMkt(applyLearningTaintFilter(svc.from("paper_trades")
              .select("symbol, signal_id, outcome, pnl_pct, realized_pnl, executed_at, closed_at")
              .not("closed_at", "is", null)
              .gte("executed_at", since)));

            // Link each signal to the trade ACTUALLY OPENED FROM IT (signal_id) — not
            // by symbol, which collided every repeat signal for the same ticker onto
            // one arbitrary trade and corrupted the outcome attribution.
            const tradeMap = new Map((trades ?? []).map((t: any) => [t.signal_id, t]));
            const enriched = (signals ?? []).map((s: any) => {
              const t = tradeMap.get(s.id) as any;
              return { ...s, trade_outcome: t?.outcome ?? null, trade_pnl_pct: t?.pnl_pct ?? null };
            });
            return JSON.stringify({ count: enriched.length, signals: enriched.slice(0, 50) });
          }

          case "query_score_correlation": {
            const dimension = call.arguments.dimension as string;
            const days = (call.arguments.days as number) ?? 60;

            // Check if this dimension is enabled in learner_config
            const cfg = dimConfig[dimension];
            if (cfg && !cfg.learn_from) {
              return JSON.stringify({ skipped: true, reason: `Dimension ${dimension} is disabled in learner_config — turned off by user` });
            }

            const result = await computeScoreCorrelation(dimension, days);
            if (result.source === "insufficient_data") {
              return JSON.stringify({ error: "Insufficient data", n: result.n, dimension });
            }
            const interpretation = result.correlation > 0.3
              ? `positive — higher score = better ${result.source === "observation_ledger" ? "benchmark-neutral return" : "P&L"}`
              : result.correlation < -0.3
              ? `negative — higher score = worse ${result.source === "observation_ledger" ? "benchmark-neutral return" : "P&L"} (consider reducing weight)`
              : "weak/no correlation";
            return JSON.stringify({
              source: result.source, dimension, n: result.n, correlation: result.correlation, interpretation,
              caveat: result.source === "observation_ledger"
                ? "INTERIM: univariate correlation on all scored candidates (incl. rejected). Phase 2 replaces this with a regularized multivariate walk-forward fit + validation gate before any weight change is trusted."
                : "Legacy paper_trades fallback — filled trades only, smaller sample than the observation ledger. NOTE: update_signal_weight refuses to mutate on this source; the ledger (10+ matured observations) is required for an actual weight change.",
            });
          }

          case "query_macro_context": {
            const days = (call.arguments.days as number) ?? 14;
            if (LEARN_MARKET === "india") {
              return JSON.stringify({
                macroSignals: [], recentMacroNotes: [], days,
                applicable: false,
                reason: "MacroSentinel is a US FRED regime and is structurally inapplicable to the India learner cohort.",
              });
            }
            const since = new Date(Date.now() - days * 86400_000).toISOString();
            const { data: macroSignals } = await svc.from("macro_signals")
              .select("*").gte("created_at", since).order("created_at", { ascending: false }).limit(20);
            const { data: learningLog } = await svc.from("learning_log")
              .select("note, created_at").gte("created_at", since)
              .ilike("note", "%macro%").limit(5);
            return JSON.stringify({ macroSignals: macroSignals ?? [], recentMacroNotes: learningLog ?? [], days });
          }

          case "read_priors": {
            const category = call.arguments.category as string | undefined;
            let query = svc.from("learning_priors").select("*").eq("enabled", true);
            if (category) query = (query as any).eq("category", category);
            const { data: priors } = await (query as any).order("confidence", { ascending: false });
            return JSON.stringify({ priors: priors ?? [], count: priors?.length ?? 0 });
          }

          case "query_learner_config": {
            const { data: config } = await svc.from("learner_config").select("*");
            const { data: weights } = await svc.from("signal_weights").select("*").single();
            const { data: strategy } = await svc.from("strategy_config").select("risk_profile, score_threshold").single();
            return JSON.stringify({ config: config ?? [], currentWeights: weights, strategy, autoGuardTripped, totalClosedTrades });
          }

          case "read_past_learnings": {
            const limit = (call.arguments.limit as number) ?? 10;
            const { data: logs } = await svc.from("learning_log")
              .select("note, weight_snapshot, trades_evaluated, created_at")
              .order("created_at", { ascending: false }).limit(limit);
            const { data: runs } = await svc.from("learner_runs")
              .select("run_date, hypotheses, weight_mutations, win_rate_snapshot, mutations_paused, pause_reason")
              .order("run_date", { ascending: false }).limit(5);
            return JSON.stringify({ recent_logs: logs ?? [], past_runs: runs ?? [] });
          }

          case "write_hypothesis": {
            const claim = call.arguments.claim as string;
            const evidence = call.arguments.evidence as string;
            const confidence = call.arguments.confidence as number;
            const actionTaken = (call.arguments.action_taken as string) ?? "none";
            const category = (call.arguments.category as string) ?? "general";
            await svc.from("learning_log").insert({
              note: `[${category.toUpperCase()}] HYPOTHESIS (${Math.round(confidence * 100)}%): ${claim} | Evidence: ${evidence} | Action: ${actionTaken}`,
              weight_snapshot: null, trades_evaluated: 0,
            });
            return JSON.stringify({ saved: true, claim, confidence, category });
          }

          case "update_signal_weight": {
            const dimension = String(call.arguments.dimension ?? "");
            const newWeight = Number(call.arguments.new_weight);
            const reason = String(call.arguments.reason ?? "");
            // n_trades/confidence are the LLM's OWN claims — kept only for the
            // human-readable log line below. They are NOT trusted for any gate:
            // nothing previously bound them to a specific query_score_correlation
            // result, so the LLM could claim n_trades:10 / confidence:0.9 for a
            // dimension whose actual correlation was computed on fewer usable
            // pairs (or came from the weaker paper_trades fallback). Every gate
            // below is checked against a FRESH server-side recomputation instead.
            const llmClaimedNTrades = Number(call.arguments.n_trades);
            const llmClaimedConfidence = Number(call.arguments.confidence ?? 0);

            // Runtime validation — tool args come from the LLM and are untrusted.
            const WEIGHT_DIMS = ["fundamental_weight", "technical_weight", "sentiment_weight", "macro_weight", "insider_weight"];
            if (!WEIGHT_DIMS.includes(dimension)) return JSON.stringify({ error: `Invalid dimension '${dimension}'. Must be one of: ${WEIGHT_DIMS.join(", ")}` });
            if (!Number.isFinite(newWeight)) return JSON.stringify({ error: "new_weight must be a finite number" });

            if (autoGuardTripped) return JSON.stringify({ error: `AUTO-GUARD (champion health): ${autoGuardReason}. Weight mutations paused. Review strategy before re-enabling.` });
            if ((totalClosedTrades ?? 0) < 10) return JSON.stringify({ error: `Phase 0 gate: ${totalClosedTrades} closed trades. Need 10+.` });

            // Server-side evidence binding: recompute the SAME correlation
            // query_score_correlation would return for this dimension, right
            // now, and gate on that — never on the LLM's claimed n_trades/confidence.
            const scoreCol = dimension.replace(/_weight$/, "_score");
            const evidence = await computeScoreCorrelation(scoreCol, 60);
            if (evidence.source !== "observation_ledger") {
              // Fail closed: the decision-observation ledger (10+ matured,
              // horizon-labeled rows) is the only source trusted to justify an
              // actual weight mutation. The paper_trades fallback remains
              // available for read-only diagnosis via query_score_correlation,
              // but a weaker/smaller sample must not move live scoring weights.
              return JSON.stringify({ error: `Ledger unavailable for ${scoreCol} (source=${evidence.source}, n=${evidence.n}) — weight mutations require the observation ledger (10+ matured rows), not the paper_trades fallback. Use query_score_correlation for read-only diagnosis only.` });
            }
            if (evidence.n < 10) return JSON.stringify({ error: `Insufficient ledger evidence for ${scoreCol} (N=${evidence.n}). Need N≥10.` });

            // Check per-dimension config
            const cfg = dimConfig[dimension];
            const dimAllowMutation = cfg?.allow_mutation ?? true;
            const dimMinConfidence = cfg?.min_confidence ?? 0.70;
            if (!dimAllowMutation) return JSON.stringify({ error: `Dimension ${dimension} has allow_mutation=false — disabled by user in learner_config` });
            // |correlation| stands in for confidence here — it's the actual,
            // server-computed effect size, not a number the LLM asserts.
            const effectSize = Math.abs(evidence.correlation);
            if (effectSize < dimMinConfidence) return JSON.stringify({ error: `Effect size |correlation|=${effectSize} < min_confidence ${dimMinConfidence} for ${dimension} (server-recomputed from ${evidence.n} ledger rows, not the LLM's claimed confidence)` });

            const nTrades = evidence.n; // server-verified, not the LLM's claim
            const confidence = effectSize;

            // BASELINE = THIS market's champion weights_snapshot (the live scoring
            // policy), falling back to the global signal_weights row only when no
            // champion exists. A challenger built off global weights would propose
            // against the wrong baseline. Parent this challenger to that champion
            // (post-057 there is one champion per market).
            const { data: champion } = await scopeMkt(svc.from("strategy_versions")
              .select("id, version, weights_snapshot")
              .eq("is_champion", true)
              .order("created_at", { ascending: false })
              .limit(1)).maybeSingle();

            // Select ONLY the weight columns — never spread metadata into weights_snapshot.
            const { data: current, error: curErr } = await svc.from("signal_weights").select(WEIGHT_DIMS.join(", ")).single();
            if (curErr && !champion) return JSON.stringify({ error: `Failed to read baseline weights (no champion, no signal_weights): ${curErr.message}` });

            // Champion snapshot keys may be either "fundamental" or "fundamental_weight".
            const snap = (champion as any)?.weights_snapshot ?? null;
            const baseVal = (d: string): number => {
              const bare = d.replace(/_weight$/, "");
              const fromChamp = snap ? (snap[d] ?? snap[bare]) : undefined;
              if (typeof fromChamp === "number") return fromChamp;
              const fromGlobal = (current as any)?.[d];
              return typeof fromGlobal === "number" ? fromGlobal : 0.25;
            };
            const currentVal = baseVal(dimension);

            // Direction sanity: raising a weight requires the ledger to show a
            // POSITIVE score->return correlation for that dimension; lowering
            // requires negative. A weight change that fights its own evidence
            // is exactly the failure mode evidence-binding exists to prevent.
            const raisingWeight = newWeight > currentVal;
            if (raisingWeight && evidence.correlation <= 0) return JSON.stringify({ error: `Cannot raise ${dimension} — ledger shows correlation ${evidence.correlation} (not positive) for ${scoreCol}` });
            if (!raisingWeight && evidence.correlation >= 0) return JSON.stringify({ error: `Cannot lower ${dimension} — ledger shows correlation ${evidence.correlation} (not negative) for ${scoreCol}` });

            const clamped = Math.max(0.05, Math.min(0.60, Math.max(currentVal - 0.05, Math.min(currentVal + 0.05, newWeight))));
            const proposedWeights: Record<string, number> = {};
            for (const d of WEIGHT_DIMS) proposedWeights[d] = baseVal(d);
            proposedWeights[dimension] = clamped;
            // Renormalize the full vector to sum to 1.0 — a single-coordinate edit
            // otherwise leaves the 5 weights summing to more/less than 1.
            const wSum = WEIGHT_DIMS.reduce((s, d) => s + (proposedWeights[d] ?? 0), 0);
            if (wSum > 0) for (const d of WEIGHT_DIMS) proposedWeights[d] = Number((proposedWeights[d] / wSum).toFixed(4));

            // CHALLENGER LIFECYCLE: Do NOT mutate signal_weights directly. The
            // immutable strategy_versions challenger row must be promoted through
            // the Strategy Registry (after validation) before it takes effect.

            // Collision-safe version: base + date + HHMMSS so two proposals on the
            // same day for the same champion don't hit a unique-constraint clash.
            const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, "");
            const nextVersion = champion
              ? `${champion.version ?? "0.0"}.learner-${today}-${stamp}`
              : `0.1.learner-${today}-${stamp}`;

            const challengerInsert: Record<string, any> = {
              version:           nextVersion,
              name:              `Challenger — ${dimension} ${currentVal.toFixed(3)}→${clamped.toFixed(3)}`,
              description:       `LearnerAgent proposed weight change. Reason: ${reason}`,
              state:             "challenger",
              parent_version_id: (champion as any)?.id ?? null,
              is_champion:       false,
              weights_snapshot:  proposedWeights,
              market:            LEARN_MARKET, // Phase 4: challenger belongs to this market
              notes:             `Proposed by LearnerAgent on ${today} for ${LEARN_MARKET.toUpperCase()}. N=${nTrades} trades (server-verified via observation ledger), effect_size=${Math.round(confidence * 100)}%. LLM claimed N=${llmClaimedNTrades}/confidence=${Math.round((Number.isFinite(llmClaimedConfidence) ? llmClaimedConfidence : 0) * 100)}% — informational only, not trusted for gating. NOT active until promoted.`,
            };
            let challengerRow: any = null, insErr: any = null;
            {
              const r = await svc.from("strategy_versions").insert(challengerInsert).select("id").single();
              if (r.error) { // pre-057: no market column — retry without it
                delete challengerInsert.market;
                const r2 = await svc.from("strategy_versions").insert(challengerInsert).select("id").single();
                challengerRow = r2.data; insErr = r2.error;
              } else { challengerRow = r.data; }
            }

            // Only report success if the challenger actually persisted.
            if (insErr || !challengerRow) {
              return JSON.stringify({ error: `Challenger insert failed: ${insErr?.message ?? "no row returned"}`, challenger_created: false });
            }

            const { error: logErr } = await svc.from("learning_log").insert({
              note: `CHALLENGER CREATED (not live): ${dimension} ${currentVal.toFixed(3)}→${clamped.toFixed(3)} | Reason: ${reason} | N=${nTrades} trades | Confidence=${Math.round(confidence * 100)}% | Promote via Strategy Registry to make active`,
              weight_snapshot: proposedWeights,
              trades_evaluated: nTrades,
            });

            // Phase 2: kick off validation immediately (fire-and-forget — don't
            // block the learner's tool response on it). The challenger cannot be
            // promoted until this produces a PASSED validation_experiments row
            // (see the fail-closed gate in app/api/strategies/versions/route.ts).
            const automated = await runAutomatedValidation(svc, {
              challengerId: (challengerRow as any).id,
              market: LEARN_MARKET,
            });

            return JSON.stringify({
              challenger_created: true,
              challenger_id: (challengerRow as any).id,
              dimension, old: currentVal, new: clamped, reason,
              log_warning: logErr?.message,
              validation: automated.validation ?? automated.automation,
              shadow: automated.shadow ?? null,
              note: "Weight NOT applied yet. Promoted to champion via /dashboard/strategies to take effect, and only after validation passes.",
            });
          }

          case "query_trade_decisions": {
            const limit = (call.arguments.limit as number) ?? 50;
            const action = call.arguments.action as string | undefined;
            const regime = call.arguments.regime as string | undefined;
            const minOutcome = call.arguments.min_outcome_score as number | undefined;
            const maxOutcome = call.arguments.max_outcome_score as number | undefined;

            let query = svc.from("trade_decisions")
              .select("symbol, action, qty, exec_price, exec_date, price_1m_after, outcome_score, pattern_tags, macro_market_regime, macro_event_tag, enrichment_status")
              .eq("enrichment_status", "enriched")
              .order("exec_date", { ascending: false })
              .limit(limit);
            if (action) query = (query as any).eq("action", action);
            if (regime) query = (query as any).ilike("macro_market_regime", `%${regime}%`);
            if (minOutcome !== undefined) query = (query as any).gte("outcome_score", minOutcome);
            if (maxOutcome !== undefined) query = (query as any).lte("outcome_score", maxOutcome);

            const { data: decisions } = await query;
            const { count: total } = await svc.from("trade_decisions").select("*", { count: "exact", head: true }).eq("enrichment_status", "enriched");

            const wins = (decisions ?? []).filter((d: any) => (d.outcome_score ?? 0) > 5).length;
            const losses = (decisions ?? []).filter((d: any) => (d.outcome_score ?? 0) < -5).length;
            const avgScore = (decisions ?? []).reduce((s: number, d: any) => s + (d.outcome_score ?? 0), 0) / Math.max((decisions ?? []).length, 1);

            const regimeBreakdown: Record<string, { count: number; avgScore: number }> = {};
            for (const d of (decisions ?? [])) {
              const r = (d as any).macro_market_regime ?? "Unknown";
              if (!regimeBreakdown[r]) regimeBreakdown[r] = { count: 0, avgScore: 0 };
              regimeBreakdown[r].count++;
              regimeBreakdown[r].avgScore += (d as any).outcome_score ?? 0;
            }
            for (const r of Object.keys(regimeBreakdown)) {
              regimeBreakdown[r].avgScore = parseFloat((regimeBreakdown[r].avgScore / regimeBreakdown[r].count).toFixed(2));
            }

            return JSON.stringify({
              total_enriched: total ?? 0,
              returned: (decisions ?? []).length,
              wins, losses, avg_outcome_score: parseFloat(avgScore.toFixed(2)),
              regime_breakdown: regimeBreakdown,
              decisions: (decisions ?? []).slice(0, 30),
              role: "behavioral_evidence_only",
              note: "Personal trade history is quarantined from alpha: it may inspire hypotheses but CANNOT satisfy n_trades or justify update_signal_weight. Any market-wide claim drawn from it must be re-tested against query_score_correlation / the observation ledger before it can support a weight change.",
            });
          }

          case "semantic_search_decisions": {
            // Validate untrusted LLM args.
            const queryText = String(call.arguments.query ?? "").trim();
            if (!queryText) return JSON.stringify({ error: "query must be a non-empty string" });
            if (queryText.length > 2000) return JSON.stringify({ error: "query too long (max 2000 chars)" });
            const rawTopK = Number(call.arguments.top_k ?? 8);
            const topK = Number.isFinite(rawTopK) ? Math.min(Math.max(Math.trunc(rawTopK), 1), 20) : 8;

            const jinaKey = process.env.JINA_API_KEY;
            if (!jinaKey) return JSON.stringify({ error: "JINA_API_KEY not set — semantic search unavailable" });

            // Embed the query via Jina AI (free, no CC required)
            const embedRes = await fetch("https://api.jina.ai/v1/embeddings", {
              method: "POST",
              headers: { "Authorization": `Bearer ${jinaKey}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                model: "jina-embeddings-v3",
                input: [queryText],
                task: "retrieval.query",
                dimensions: 1024,
                embedding_type: "float",
              }),
              signal: AbortSignal.timeout(20_000),
            });
            if (!embedRes.ok) return JSON.stringify({ error: `Jina embed failed: ${embedRes.status}` });
            const embedData = await embedRes.json();
            const vec: number[] = embedData.data?.[0]?.embedding ?? [];
            // Require exactly 1024 finite numbers before it reaches PostgreSQL.
            if (vec.length !== 1024 || !vec.every((n) => Number.isFinite(n))) {
              return JSON.stringify({ error: `Bad query embedding: expected 1024 finite dims, got ${vec.length}` });
            }

            // Parameterized RPC (migration 047) — clamps match_count, INVOKER rights.
            const pgVec = `[${vec.join(",")}]`;
            const { data: rows, error: sqlErr } = await svc.rpc("semantic_search_trade_decisions" as any, {
              query_embedding: pgVec,
              match_count: topK,
            } as any);

            if (sqlErr) {
              return JSON.stringify({ error: `Semantic search failed: ${sqlErr.message}. If no embeddings exist yet, run POST /api/live-portfolio/embed first.`, query: queryText });
            }

            return JSON.stringify({
              query: queryText, top_k: topK, results: rows ?? [],
              role: "behavioral_evidence_only",
              note: "Personal trade history is quarantined from alpha: it may inspire hypotheses but CANNOT satisfy n_trades or justify update_signal_weight.",
            });
          }

          case "propose_feature": {
            // Phase 3 learning-core: propose a NEW candidate feature as a
            // machine-readable spec. The formula is NEVER executed here — it's
            // stored as 'proposed' and only interpreted later, through the
            // whitelisted grammar (lib/validation/feature-compiler.ts), by the
            // deterministic feature-check job which decides promotion on
            // out-of-sample IC. The LLM never runs code, ever.
            const name = String(call.arguments.name ?? "").trim();
            const formula = String(call.arguments.formula ?? "").trim();
            const inputs = Array.isArray(call.arguments.inputs) ? call.arguments.inputs.map(String) : [];
            const rationale = String(call.arguments.rationale ?? "");
            if (!name || !formula || inputs.length === 0) {
              return JSON.stringify({ error: "name, formula, and a non-empty inputs array are required" });
            }
            const inputCheck = validateFeatureInputs(formula, inputs);
            if (!inputCheck.ok) {
              return JSON.stringify({ error: `Formula rejected: ${inputCheck.reason}` });
            }
            const { data: existing } = await svc.from("feature_registry").select("id").eq("name", name).maybeSingle();
            if (existing) return JSON.stringify({ error: `Feature '${name}' already exists (id ${(existing as any).id})` });

            const { data: row, error: insErr } = await svc.from("feature_registry").insert({
              name,
              spec: {
                rationale, formula, inputs,
                lag_days: call.arguments.lag_days ?? 0,
                expected_sign: call.arguments.expected_sign ?? null,
                horizon: call.arguments.horizon ?? 10,
                universe: call.arguments.universe ?? LEARN_MARKET,
                falsification_test: call.arguments.falsification_test ?? null,
              },
              status: "proposed", proposed_by: "learner",
            }).select("id").single();
            if (insErr || !row) return JSON.stringify({ error: `Feature insert failed: ${insErr?.message ?? "no row"}` });

            await svc.from("feature_registry_history").insert({
              feature_id: (row as any).id, from_status: null, to_status: "proposed", reason: rationale ?? "proposed by learner",
            }).then(() => {}, () => {});

            return JSON.stringify({
              feature_created: true, feature_id: (row as any).id, name,
              note: "Status 'proposed' — the feature-check job will test its out-of-sample IC before it can ever influence scoring. It does NOT affect analyst_score until it reaches 'active'.",
            });
          }

          case "finish": {
            return JSON.stringify(call.arguments);
          }

          default:
            return JSON.stringify({ error: `Unknown tool: ${call.name}` });
        }
      }

      // Build system context for agent
      const tradingMandate = await loadTradingMandate(svc, LEARN_MARKET);
      const enabledDims = Object.entries(dimConfig).filter(([, v]: [string, any]) => v.learn_from).map(([k]) => k);
      const frozenDims = Object.entries(dimConfig).filter(([, v]: [string, any]) => !v.allow_mutation).map(([k]) => k);

      const systemPrompt = `You are the LearnerAgent for a US equity paper trading system. You are a TRUE AI AGENT — you have tools, you call them, you reason about the results, and you evolve the signal scoring strategy over time.

CURRENT DATE: ${today}
TOTAL CLOSED TRADES ALL TIME: ${totalClosedTrades ?? 0}
TRADES CLOSED THIS RUN: ${outcomes.length}
TOTAL SIGNALS IN DB: ${signalCount ?? 0}
AUTO-GUARD STATUS: ${autoGuardTripped ? `TRIPPED — ${autoGuardReason}. Weight mutations BLOCKED until manual review.` : "OK"}

DIMENSION CONFIGURATION (from learner_config — set by user):
- Learn from: ${enabledDims.join(", ") || "all"}
- Frozen (no mutation): ${frozenDims.join(", ") || "none"}
- Per-dimension min_confidence: ${Object.entries(dimConfig).map(([k, v]: [string, any]) => `${k}=${v.min_confidence ?? 0.70}`).join(", ")}

AVAILABLE TOOLS:
1. read_priors — read human-written Bayesian market principles (start here for context)
2. query_learner_config — see current weights, strategy, dimension config, and auto-guard status
3. query_signals_with_outcomes — signals + their trade outcomes (filter by days, min_score, asset_class)
4. query_score_correlation — Pearson correlation between a score dimension and P&L (respects learner_config)
5. query_macro_context — recent macro signals and geopolitical/economic data from MacroSentinel
6. read_past_learnings — your previous hypotheses and weight changes
7. query_trade_decisions — REAL historical trades (10 years of CSV history + Robinhood MCP). Returns outcome_score per decision, regime breakdown, behavioral win/loss patterns. Use this to find what the user does right/wrong across market regimes.
8. write_hypothesis — save a finding (include category: "fundamental"|"technical"|"macro"|"insider"|"general")
9. update_signal_weight — propose a weight change. Creates an immutable CHALLENGER in strategy_versions. NOT applied until user promotes it via Strategy Registry. Gated: phase gate + per-dim config + auto-guard.
10. semantic_search_decisions — vector similarity search over enriched trade decisions (RAG). Find past trades matching a situation ("rate-hike sell-off", "earnings miss hold", "momentum break"). Returns top-K decisions with outcome_score. Use AFTER query_trade_decisions to drill into specific scenarios.
11. finish — complete run with summary, hypotheses array, and Mermaid diagram

MERMAID DIAGRAM REQUIREMENTS — the finish.mermaid MUST follow this structure:
flowchart TD
  INPUTS["📥 Inputs\\n• N signals analyzed\\n• N closed trades\\n• macro: [key macro events or 'none']\\n• priors loaded: Y\\n• dims enabled: [list]"]
  ANALYSIS["🔍 Analysis\\n• [finding 1]\\n• [finding 2]"]
  HYPOTHESES["💡 Hypotheses\\n• [hypothesis with confidence %]"]
  MUTATIONS["⚡ Weight Changes\\n• [dim: old→new]\\nor 'none (phase gate)'"]
  INPUTS --> ANALYSIS --> HYPOTHESES --> MUTATIONS

Always show real numbers. Never say "see DB" — embed the actual values.

Personal trade history (query_trade_decisions / semantic_search_decisions) is BEHAVIORAL evidence only — never cite it as justification for update_signal_weight. update_signal_weight independently recomputes the observation-ledger correlation for the target dimension server-side and refuses to run at all if only the weaker paper-trades fallback is available — your n_trades/confidence arguments are logged for context only and are not what gates the mutation.

REASONING APPROACH:
1. Start with read_priors to load background market knowledge
2. Check query_learner_config to see current state
3. Query signals_with_outcomes for recent paper trade performance
4. Run query_score_correlation for each ENABLED dimension
5. Check query_macro_context — does macro explain wins/losses?
6. Call query_trade_decisions — analyze real historical trade patterns across ALL regimes. Look for: regime-specific win rates, buy vs sell accuracy, stocks the user consistently loses on, macro periods where decisions were best/worst.
6b. Use semantic_search_decisions for drill-down: if you see a pattern (e.g. losses during rate hikes), run semantic_search to find semantically similar past decisions and check if they share a common failure mode.
7. Read past learnings to avoid repeating old hypotheses
8. Form hypotheses with evidence + confidence (ground in both paper trades AND real trade history)
9. Mutate weights only if: N≥10 trades + confidence ≥ dim_min_confidence + not auto-guarded
10. Call finish with complete structured Mermaid`;

      const initialMessage = `Run your weekly ${LEARN_MARKET.toUpperCase()} learning analysis under this immutable user Trading Mandate: ${JSON.stringify(tradingMandate)}. You may propose challengers but cannot change the mandate; any proposed horizon must remain inside ${tradingMandate.min_hold_days}-${tradingMandate.max_hold_days} market days. Start with read_priors to load background context, then check learner_config for current state. Query all enabled signal dimensions for correlation with P&L. Check macro context to understand if external factors explain performance. Form grounded hypotheses. Only mutate weights if evidence is sufficient. Finish with a complete Mermaid diagram showing ALL inputs consumed this run.`;

      const LEARNER_TOOLS = [
        { name: "read_priors", description: "Read human-written Bayesian market principles as background context", parameters: { type: "object", properties: { category: { type: "string", enum: ["fundamental", "technical", "macro", "insider", "general"] } } } },
        { name: "query_learner_config", description: "Read current signal weights, strategy config, dimension enable/freeze config, and auto-guard status", parameters: { type: "object", properties: {} } },
        { name: "query_signals_with_outcomes", description: "Get signals joined with trade outcomes. Filter by days, min score, or asset_class", parameters: { type: "object", properties: { days: { type: "number" }, min_analyst_score: { type: "number" }, asset_class: { type: "string", enum: ["us_equity", "etf", "metal"] } } } },
        { name: "query_score_correlation", description: "Pearson correlation between a score dimension and P&L. Skipped if dimension disabled in config.", parameters: { type: "object", properties: { dimension: { type: "string", enum: ["fundamental_score", "technical_score", "sentiment_score", "macro_score", "insider_score", "analyst_score"] }, days: { type: "number" } }, required: ["dimension"] } },
        { name: "query_macro_context", description: "Get recent macro signals (rates, geopolitical events, sector rotations) from MacroSentinel", parameters: { type: "object", properties: { days: { type: "number" } } } },
        { name: "read_past_learnings", description: "Read past learning log and previous learner run summaries", parameters: { type: "object", properties: { limit: { type: "number" } } } },
        { name: "write_hypothesis", description: "Save a finding or hypothesis", parameters: { type: "object", properties: { claim: { type: "string" }, evidence: { type: "string" }, confidence: { type: "number" }, action_taken: { type: "string" }, category: { type: "string", enum: ["fundamental", "technical", "macro", "insider", "general"] } }, required: ["claim", "evidence", "confidence"] } },
        { name: "update_signal_weight", description: "Propose a weight change — creates an immutable challenger in strategy_versions. NOT applied until promoted via Strategy Registry. Gated by phase gate, per-dim config, auto-guard, AND a server-side recomputation of the observation-ledger correlation for this dimension (refuses if only the paper-trades fallback is available, or if the ledger's correlation sign contradicts the direction of your proposed change). n_trades/confidence are recorded for context only — the actual gate uses the server's own fresh correlation query, not these values.", parameters: { type: "object", properties: { dimension: { type: "string", enum: ["fundamental_weight", "technical_weight", "sentiment_weight", "macro_weight", "insider_weight"] }, new_weight: { type: "number", minimum: 0.05, maximum: 0.60 }, reason: { type: "string" }, n_trades: { type: "integer", minimum: 10, description: "Your own estimate — informational only, not used for gating" }, confidence: { type: "number", minimum: 0, maximum: 1, description: "Your own estimate — informational only, not used for gating" } }, required: ["dimension", "new_weight", "reason", "n_trades", "confidence"] } },
        { name: "query_trade_decisions", description: "Query enriched real trade history (CSV imports + Robinhood MCP). Returns outcome_score per trade (positive=good decision), regime breakdown, win/loss counts. Use to find behavioral patterns in the user's actual trading history.", parameters: { type: "object", properties: { limit: { type: "number", description: "Max trades to return (default 50)" }, action: { type: "string", enum: ["buy", "sell"], description: "Filter by buy or sell" }, regime: { type: "string", description: "Filter by macro regime name (partial match)" }, min_outcome_score: { type: "number", description: "Filter decisions with outcome_score >= this" }, max_outcome_score: { type: "number", description: "Filter decisions with outcome_score <= this" } } } },
        { name: "semantic_search_decisions", description: "Vector similarity search over enriched trade decisions using Jina embeddings (the configured provider — EMBEDDING_PROVIDER, default jina). Use to find trades similar to a situation ('tech sell-off Q4', 'rate hike momentum trade', 'earnings miss hold'), or to answer 'what did I do when X happened'. Returns top-K decisions with outcome data. Only works if embeddings have been built (POST /api/live-portfolio/embed).", parameters: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 2000, description: "Natural language query describing the trade situation to search for" }, top_k: { type: "integer", minimum: 1, maximum: 20, description: "Number of results to return (default 8, max 20)" } }, required: ["query"] } },
        { name: "propose_feature", description: "Propose a NEW candidate feature as a machine-readable spec (Phase 3). The formula is NEVER executed by you — it's stored as 'proposed' and only interpreted later by a whitelisted-grammar compiler (operators + - * / and functions log/abs/min/max/lag only). It has ZERO effect on scoring until a deterministic out-of-sample IC check promotes it to 'active'. Use this to propose a hypothesis-driven signal you can't express as a weight change.", parameters: { type: "object", properties: {
          name: { type: "string", description: "Unique short name, e.g. 'pe_to_growth_ratio'" },
          formula: { type: "string", description: "Whitelisted expression using ONLY: numbers, the declared inputs, + - * /, and log()/abs()/min()/max()/lag(field,n). No other syntax is interpreted." },
          inputs: { type: "array", items: { type: "string" }, description: "Every identifier the formula references — anything not declared here is rejected even if it appears in the formula." },
          rationale: { type: "string", description: "Economic rationale for why this might predict returns" },
          expected_sign: { type: "string", enum: ["positive", "negative"] },
          horizon: { type: "number", enum: [2, 5, 10, 20] },
          falsification_test: { type: "string", description: "What observation would prove this feature is NOT predictive" },
        }, required: ["name", "formula", "inputs", "rationale"] } },
        { name: "finish", description: "Complete the run. Must include summary, hypotheses array, and structured Mermaid diagram with inputs node.", parameters: { type: "object", properties: { summary: { type: "string" }, mermaid: { type: "string" }, hypotheses: { type: "array", items: { type: "object" } } }, required: ["summary", "mermaid", "hypotheses"] } },
      ];

      try {
        const loopResult = await runAgentLoop({
          model: agentModel,
          systemPrompt,
          initialMessage,
          tools: LEARNER_TOOLS,
          toolExecutor,
          maxIterations: 18,
          task: "summarize",
          agentLabel: "learner",
          runId: runId ?? undefined,
        });

        const finishCall = loopResult.toolCalls.find(c => c.name === "finish");
        let finishArgs: any = {};
        try { finishArgs = typeof finishCall?.args === "object" ? finishCall.args : {}; } catch { finishArgs = {}; }

        const hypotheses = finishArgs.hypotheses ?? [];
        const weightMutations = loopResult.toolCalls
          .filter(c => c.name === "update_signal_weight" && !c.result.includes("error") && !c.result.includes("gate") && !c.result.includes("AUTO-GUARD") && !c.result.includes("Confidence") && !c.result.includes("disabled"))
          .map(c => c.args);
        const reasoningChain = loopResult.toolCalls.map((c, i) => ({ step: i + 1, tool: c.name, args: c.args, result: c.result }));

        const mermaid = finishArgs.mermaid ?? `flowchart TD\n  INPUTS["📥 Inputs\\n• ${signalCount ?? 0} signals\\n• ${totalClosedTrades ?? 0} closed trades\\n• macro: not checked\\n• priors: not loaded"]\n  ANALYSIS["🔍 Analysis\\n• ${outcomes.length} trades closed this run"]\n  HYPOTHESES["💡 Hypotheses\\n• ${hypotheses.length} saved"]\n  MUTATIONS["⚡ Weight Changes\\n• none (insufficient data)"]\n  INPUTS --> ANALYSIS --> HYPOTHESES --> MUTATIONS`;

        const winRateSnapshot = outcomes.length > 0 ? Math.round((outcomes.filter((o: any) => o.outcome === "win").length / outcomes.length) * 100) : null;

        await svc.from("learner_runs").upsert({
          run_date: today,
          market: LEARN_MARKET,
          signals_analyzed: signalCount ?? 0,
          trades_analyzed: outcomes.length,
          hypotheses,
          weight_mutations: weightMutations,
          reasoning_chain: reasoningChain,
          mermaid_per_run: mermaid,
          model_used: agentModel,
          win_rate_snapshot: winRateSnapshot,
          tokens_in: loopResult.tokensIn,
          tokens_out: loopResult.tokensOut,
          mutations_paused: autoGuardTripped,
          pause_reason: autoGuardTripped ? `Auto-guard (champion health): ${autoGuardReason}` : null,
        }, { onConflict: "run_date,market" });

        learnerResult = { summary: finishArgs.summary, hypotheses, weightMutations, steps: loopResult.steps, tokensIn: loopResult.tokensIn, tokensOut: loopResult.tokensOut, autoGuardTripped };
      } catch (agentErr) {
        console.error("[learner] agent loop failed:", agentErr);
        await svc.from("learner_runs").upsert({
          run_date: today,
          market: LEARN_MARKET,
          signals_analyzed: signalCount ?? 0,
          trades_analyzed: outcomes.length,
          mermaid_per_run: `flowchart TD\n  ERROR["❌ Agent loop error\\n${String(agentErr).slice(0, 100)}"]`,
          model_used: agentModel, tokens_in: 0, tokens_out: 0,
        }, { onConflict: "run_date,market" });
      }
    }

    const wins = outcomes.filter(o => o.outcome === "win").length;
    const losses = outcomes.filter(o => o.outcome === "loss").length;

    await svc.from("learning_log").insert({
      note: `Run ${today}: closed ${outcomes.length} trades (${wins}W/${losses}L). ${priceFailures.length} price failures. ${positionReassessments.length} reassessments. Agent: ${learnerResult ? `${learnerResult.steps} steps, ${learnerResult.hypotheses?.length ?? 0} hypotheses, ${learnerResult.weightMutations?.length ?? 0} mutations${autoGuardTripped ? " [AUTO-GUARD ACTIVE]" : ""}` : "skipped (already ran today or disabled)"}.`,
      weight_snapshot: null,
      trades_evaluated: outcomes.length,
    });

    if (runId) {
      await svc.from("agent_runs").update({
        status: "done",
        symbols: outcomes.map(o => o.symbol),
        signals_written: outcomes.length,
        result_summary: `Closed ${outcomes.length} trades: ${wins}W/${losses}L. ${learnerResult?.hypotheses?.length ?? 0} hypotheses, ${learnerResult?.weightMutations?.length ?? 0} mutations.`,
        completed_at: new Date().toISOString(),
        tokens_input: learnerResult?.tokensIn ?? 0,
        tokens_output: learnerResult?.tokensOut ?? 0,
        claude_calls: learnerResult?.steps ?? 0,
      } as any).eq("id", runId);
    }

    return NextResponse.json({
      success: true, closed: outcomes.length, priceFailures: priceFailures.length,
      outcomes, positionReassessments, autoGuardTripped,
      learner: learnerResult ?? { skipped: true, reason: "Already ran today or disabled" },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
