import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchQuote } from "@/lib/market-data";
import { runAgentLoop, ToolCall } from "@/lib/llm-router";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const cronSecret = req.headers.get("x-cron-secret");
    const isCron = cronSecret && cronSecret === process.env.CRON_SECRET;
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
    const LEARN_MARKET = "us";
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
      const { data: todaysRun } = await svc
        .from("agent_runs")
        .select("id, status, started_at, trigger_source")
        .eq("agent_type", "learner")
        .gte("started_at", dayStart)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (todaysRun) {
        return NextResponse.json({
          skipped: true,
          reason: `Learner already ran today (run ${(todaysRun as any).id}, ${(todaysRun as any).trigger_source} at ${(todaysRun as any).started_at}). Pass { force: true } to re-run.`,
        });
      }
    }

    const { data: runRow } = await svc.from("agent_runs").insert({
      agent_type: "learner", status: "running",
      trigger_source: isCron ? "scheduled" : "manual",
    } as any).select().single();
    const runId = (runRow as any)?.id ?? null;

    // ── Phase A: Rule-based trade closing ──────────────────────────────────────
    // paper_positions has no closed_at column (every row is open by
    // definition — closing means deleting the row, see position-monitor's
    // closePosition) and no created_at (real column is opened_at). This
    // query silently errored on the old filter and always returned nothing.
    const positionReassessments: string[] = [];
    const { data: openPositions } = await svc.from("paper_positions").select("*");

    if (openPositions?.length) {
      for (const pos of openPositions) {
        const ageMs = Date.now() - new Date(pos.opened_at ?? 0).getTime();
        if (ageMs < 7 * 86400_000) continue;
        const daysSince = pos.target_updated_at
          ? (Date.now() - new Date(pos.target_updated_at).getTime()) / 86400_000 : 999;
        if (daysSince < 6) continue;

        const { data: sig } = await svc.from("agent_signals")
          .select("analyst_score, direction")
          .eq("symbol", pos.symbol)
          .order("created_at", { ascending: false })
          .limit(1).single();

        if (!sig) continue;
        if (sig.analyst_score < 40 || sig.direction === "short") {
          await svc.from("paper_positions").update({ exit_reason: "llm_exit", target_updated_at: new Date().toISOString() }).eq("id", pos.id);
          positionReassessments.push(`${pos.symbol}: flagged llm_exit (score=${sig.analyst_score})`);
        } else if (sig.analyst_score >= 65 && pos.price_target) {
          const newTarget = parseFloat((pos.price_target * 1.05).toFixed(2));
          await svc.from("paper_positions").update({ price_target: newTarget, target_updated_at: new Date().toISOString() }).eq("id", pos.id);
          positionReassessments.push(`${pos.symbol}: target raised →$${newTarget}`);
        } else {
          await svc.from("paper_positions").update({ target_updated_at: new Date().toISOString() }).eq("id", pos.id);
        }
      }
    }

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
    const { data: openTrades } = await svc.from("paper_trades").select("*").is("closed_at", null).lt("executed_at", cutoff);

    const outcomes: any[] = [];
    const priceFailures: string[] = [];

    for (const trade of openTrades ?? []) {
      // Only reconcile orphans — if a position still exists for this symbol,
      // it's a live holding managed by PositionMonitor; leave it alone.
      const { data: livePos } = await svc.from("paper_positions")
        .select("id").eq("symbol", trade.symbol).maybeSingle();
      if (livePos) continue;

      const quote = await fetchQuote(trade.symbol);
      if (quote.source === "unavailable" || quote.price <= 0) { priceFailures.push(trade.symbol); continue; }

      const exitPrice = quote.price;
      const pnl = (exitPrice - trade.fill_price) * trade.qty;
      const pnlPct = ((exitPrice - trade.fill_price) / trade.fill_price) * 100;
      const outcome = pnl > 0.5 ? "win" : pnl < -0.5 ? "loss" : "breakeven";

      // Close the dangling trade row. Do NOT credit cash again — the position
      // that this trade belonged to was already closed by PositionMonitor, which
      // already credited the proceeds. Double-crediting here would inflate NAV.
      await svc.from("paper_trades").update({ exit_price: exitPrice, realized_pnl: pnl, pnl_pct: pnlPct, outcome, closed_at: new Date().toISOString() }).eq("id", trade.id);

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
      svc.from("learner_runs").select("id").eq("run_date", new Date().toISOString().slice(0, 10)).single(),
      scopeMkt(svc.from("paper_trades").select("*", { count: "exact", head: true }).not("closed_at", "is", null)),
      svc.from("learner_config").select("*"),
      svc.from("learner_runs").select("win_rate_snapshot, mutations_paused, run_date").order("run_date", { ascending: false }).limit(5),
    ]);

    const agentModel = (agentCfg as any)?.model ?? "claude-opus-4-8";
    const agentEnabled = (agentCfg as any)?.enabled ?? true;
    const today = new Date().toISOString().slice(0, 10);

    // Build dimension config map
    const dimConfig: Record<string, any> = {};
    for (const cfg of learnerConfig ?? []) {
      dimConfig[(cfg as any).dimension] = cfg;
    }

    // Auto-guard: check if last 3 runs had win_rate < 35% → pause mutations
    const last3 = (recentRuns ?? []).slice(0, 3);
    const autoGuardTripped = last3.length >= 3 && last3.every((r: any) =>
      r.win_rate_snapshot !== null && r.win_rate_snapshot < 35
    );

    let learnerResult: any = null;

    if (agentEnabled && !existingRun) {
      const { count: signalCount } = await svc.from("agent_signals").select("*", { count: "exact", head: true });

      // ── Tool implementations ────────────────────────────────────────────────

      async function toolExecutor(call: ToolCall): Promise<string> {
        switch (call.name) {

          case "query_signals_with_outcomes": {
            const days = (call.arguments.days as number) ?? 30;
            const minScore = (call.arguments.min_analyst_score as number) ?? 0;
            const assetClass = call.arguments.asset_class as string | undefined;
            const since = new Date(Date.now() - days * 86400_000).toISOString();

            let query = scopeMkt(svc.from("agent_signals")
              .select("symbol, direction, analyst_score, fundamental_score, technical_score, sentiment_score, macro_score, insider_score, created_at, source, asset_class")
              .gte("created_at", since)
              .gte("analyst_score", minScore)
              .order("created_at", { ascending: false })
              .limit(100));
            if (assetClass) query = (query as any).eq("asset_class", assetClass);

            const { data: signals } = await query;
            const { data: trades } = await scopeMkt(svc.from("paper_trades")
              .select("symbol, outcome, pnl_pct, realized_pnl, executed_at, closed_at")
              .not("closed_at", "is", null)
              .gte("executed_at", since));

            const tradeMap = new Map((trades ?? []).map((t: any) => [t.symbol, t]));
            const enriched = (signals ?? []).map((s: any) => ({
              ...s, trade_outcome: (tradeMap.get(s.symbol) as any)?.outcome ?? null, trade_pnl_pct: (tradeMap.get(s.symbol) as any)?.pnl_pct ?? null,
            }));
            return JSON.stringify({ count: enriched.length, signals: enriched.slice(0, 50) });
          }

          case "query_score_correlation": {
            const dimension = call.arguments.dimension as string;
            const days = (call.arguments.days as number) ?? 60;
            const since = new Date(Date.now() - days * 86400_000).toISOString();

            // Check if this dimension is enabled in learner_config
            const cfg = dimConfig[dimension];
            if (cfg && !cfg.learn_from) {
              return JSON.stringify({ skipped: true, reason: `Dimension ${dimension} is disabled in learner_config — turned off by user` });
            }

            const { data: signals } = await scopeMkt(svc.from("agent_signals")
              .select(`symbol, ${dimension}, created_at`)
              .gte("created_at", since).not(dimension, "is", null).limit(100));
            const { data: trades } = await scopeMkt(svc.from("paper_trades")
              .select("symbol, pnl_pct, executed_at")
              .not("closed_at", "is", null).gte("executed_at", since));

            const tradeMap = new Map<string, number | null>((trades ?? []).map((t: any) => [t.symbol as string, t.pnl_pct as number | null]));
            const pairs: { score: number; pnl: number }[] = [];
            for (const s of signals ?? []) {
              const pnl = tradeMap.get(s.symbol);
              const score = (s as any)[dimension];
              if (pnl != null && score != null) pairs.push({ score, pnl: pnl as number });
            }

            if (pairs.length < 3) return JSON.stringify({ error: "Insufficient data", n: pairs.length, dimension });

            const n = pairs.length;
            const meanScore = pairs.reduce((a, b) => a + b.score, 0) / n;
            const meanPnl = pairs.reduce((a, b) => a + b.pnl, 0) / n;
            const num = pairs.reduce((a, b) => a + (b.score - meanScore) * (b.pnl - meanPnl), 0);
            const denScore = Math.sqrt(pairs.reduce((a, b) => a + Math.pow(b.score - meanScore, 2), 0));
            const denPnl = Math.sqrt(pairs.reduce((a, b) => a + Math.pow(b.pnl - meanPnl, 2), 0));
            const correlation = denScore * denPnl === 0 ? 0 : parseFloat((num / (denScore * denPnl)).toFixed(3));
            return JSON.stringify({ dimension, n, correlation, interpretation: correlation > 0.3 ? "positive — higher score = better P&L" : correlation < -0.3 ? "negative — higher score = worse P&L (consider reducing weight)" : "weak/no correlation" });
          }

          case "query_macro_context": {
            const days = (call.arguments.days as number) ?? 14;
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
            const nTrades = Number(call.arguments.n_trades);
            const confidence = Number(call.arguments.confidence ?? 0);

            // Runtime validation — tool args come from the LLM and are untrusted.
            // NaN/missing values must not slip past the numeric gates below.
            const WEIGHT_DIMS = ["fundamental_weight", "technical_weight", "sentiment_weight", "macro_weight", "insider_weight"];
            if (!WEIGHT_DIMS.includes(dimension)) return JSON.stringify({ error: `Invalid dimension '${dimension}'. Must be one of: ${WEIGHT_DIMS.join(", ")}` });
            if (!Number.isFinite(newWeight)) return JSON.stringify({ error: "new_weight must be a finite number" });
            if (!Number.isInteger(nTrades) || nTrades < 0) return JSON.stringify({ error: "n_trades must be a non-negative integer" });
            if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return JSON.stringify({ error: "confidence must be a number between 0 and 1" });

            if (autoGuardTripped) return JSON.stringify({ error: "AUTO-GUARD: last 3 runs had win_rate < 35%. Weight mutations paused. Review strategy before re-enabling." });
            if ((totalClosedTrades ?? 0) < 10) return JSON.stringify({ error: `Phase 0 gate: ${totalClosedTrades} closed trades. Need 10+.` });
            if (nTrades < 10) return JSON.stringify({ error: `Insufficient trades (N=${nTrades}). Need N≥10.` });

            // Check per-dimension config
            const cfg = dimConfig[dimension];
            const dimAllowMutation = cfg?.allow_mutation ?? true;
            const dimMinConfidence = cfg?.min_confidence ?? 0.70;
            if (!dimAllowMutation) return JSON.stringify({ error: `Dimension ${dimension} has allow_mutation=false — disabled by user in learner_config` });
            if (confidence < dimMinConfidence) return JSON.stringify({ error: `Confidence ${confidence} < min_confidence ${dimMinConfidence} for ${dimension}` });

            // Select ONLY the weight columns — never spread metadata (ids/timestamps)
            // into weights_snapshot, or promotion code that iterates keys breaks.
            const { data: current, error: curErr } = await svc.from("signal_weights").select(WEIGHT_DIMS.join(", ")).single();
            if (curErr) return JSON.stringify({ error: `Failed to read current weights: ${curErr.message}` });
            const currentVal = Number((current as any)?.[dimension] ?? 0.25);
            const clamped = Math.max(0.05, Math.min(0.60, Math.max(currentVal - 0.05, Math.min(currentVal + 0.05, newWeight))));
            const proposedWeights: Record<string, number> = {};
            for (const d of WEIGHT_DIMS) proposedWeights[d] = Number((current as any)?.[d] ?? 0.25);
            proposedWeights[dimension] = clamped;

            // CHALLENGER LIFECYCLE: Do NOT mutate signal_weights directly.
            // Create an immutable strategy_versions challenger row. It must be
            // promoted through the Strategy Registry before it takes effect.
            // This is the architecture gate that prevents learning from immediately
            // overwriting the champion strategy without human review.
            // Parent this challenger to THIS market's champion (post-057 there is
            // one champion per market — an unscoped lookup would grab the wrong one).
            const { data: champion } = await scopeMkt(svc.from("strategy_versions")
              .select("id, version, weights_snapshot")
              .eq("is_champion", true)
              .order("created_at", { ascending: false })
              .limit(1)).maybeSingle();

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
              notes:             `Proposed by LearnerAgent on ${today} for ${LEARN_MARKET.toUpperCase()}. N=${nTrades} trades, confidence=${Math.round(confidence * 100)}%. NOT active until promoted.`,
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
            return JSON.stringify({
              challenger_created: true,
              challenger_id: (challengerRow as any).id,
              dimension, old: currentVal, new: clamped, reason,
              log_warning: logErr?.message,
              note: "Weight NOT applied yet. Promoted to champion via /dashboard/strategies to take effect.",
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
            });
          }

          case "semantic_search_decisions": {
            // Validate untrusted LLM args.
            const queryText = String(call.arguments.query ?? "").trim();
            if (!queryText) return JSON.stringify({ error: "query must be a non-empty string" });
            if (queryText.length > 2000) return JSON.stringify({ error: "query too long (max 2000 chars)" });
            const rawTopK = Number(call.arguments.top_k ?? 8);
            const topK = Number.isFinite(rawTopK) ? Math.min(Math.max(Math.trunc(rawTopK), 1), 20) : 8;

            const voyageKey = process.env.VOYAGE_API_KEY;
            if (!voyageKey) return JSON.stringify({ error: "VOYAGE_API_KEY not set — semantic search unavailable" });

            // Embed the query via Voyage AI
            const embedRes = await fetch("https://api.voyageai.com/v1/embeddings", {
              method: "POST",
              headers: { "Authorization": `Bearer ${voyageKey}`, "Content-Type": "application/json" },
              body: JSON.stringify({ model: "voyage-finance-2", input: [queryText], input_type: "query" }),
              signal: AbortSignal.timeout(20_000),
            });
            if (!embedRes.ok) return JSON.stringify({ error: `Voyage embed failed: ${embedRes.status}` });
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

            return JSON.stringify({ query: queryText, top_k: topK, results: rows ?? [] });
          }

          case "finish": {
            return JSON.stringify(call.arguments);
          }

          default:
            return JSON.stringify({ error: `Unknown tool: ${call.name}` });
        }
      }

      // Build system context for agent
      const enabledDims = Object.entries(dimConfig).filter(([, v]: [string, any]) => v.learn_from).map(([k]) => k);
      const frozenDims = Object.entries(dimConfig).filter(([, v]: [string, any]) => !v.allow_mutation).map(([k]) => k);

      const systemPrompt = `You are the LearnerAgent for a US equity paper trading system. You are a TRUE AI AGENT — you have tools, you call them, you reason about the results, and you evolve the signal scoring strategy over time.

CURRENT DATE: ${today}
TOTAL CLOSED TRADES ALL TIME: ${totalClosedTrades ?? 0}
TRADES CLOSED THIS RUN: ${outcomes.length}
TOTAL SIGNALS IN DB: ${signalCount ?? 0}
AUTO-GUARD STATUS: ${autoGuardTripped ? "TRIPPED — win_rate < 35% for 3 consecutive runs. Weight mutations BLOCKED until manual review." : "OK"}

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

      const initialMessage = `Run your weekly learning analysis. Start with read_priors to load background context, then check learner_config for current state. Query all enabled signal dimensions for correlation with P&L. Check macro context to understand if external factors explain performance. Form grounded hypotheses. Only mutate weights if evidence is sufficient. Finish with a complete Mermaid diagram showing ALL inputs consumed this run.`;

      const LEARNER_TOOLS = [
        { name: "read_priors", description: "Read human-written Bayesian market principles as background context", parameters: { type: "object", properties: { category: { type: "string", enum: ["fundamental", "technical", "macro", "insider", "general"] } } } },
        { name: "query_learner_config", description: "Read current signal weights, strategy config, dimension enable/freeze config, and auto-guard status", parameters: { type: "object", properties: {} } },
        { name: "query_signals_with_outcomes", description: "Get signals joined with trade outcomes. Filter by days, min score, or asset_class", parameters: { type: "object", properties: { days: { type: "number" }, min_analyst_score: { type: "number" }, asset_class: { type: "string", enum: ["us_equity", "etf", "metal"] } } } },
        { name: "query_score_correlation", description: "Pearson correlation between a score dimension and P&L. Skipped if dimension disabled in config.", parameters: { type: "object", properties: { dimension: { type: "string", enum: ["fundamental_score", "technical_score", "sentiment_score", "macro_score", "insider_score", "analyst_score"] }, days: { type: "number" } }, required: ["dimension"] } },
        { name: "query_macro_context", description: "Get recent macro signals (rates, geopolitical events, sector rotations) from MacroSentinel", parameters: { type: "object", properties: { days: { type: "number" } } } },
        { name: "read_past_learnings", description: "Read past learning log and previous learner run summaries", parameters: { type: "object", properties: { limit: { type: "number" } } } },
        { name: "write_hypothesis", description: "Save a finding or hypothesis", parameters: { type: "object", properties: { claim: { type: "string" }, evidence: { type: "string" }, confidence: { type: "number" }, action_taken: { type: "string" }, category: { type: "string", enum: ["fundamental", "technical", "macro", "insider", "general"] } }, required: ["claim", "evidence", "confidence"] } },
        { name: "update_signal_weight", description: "Propose a weight change — creates an immutable challenger in strategy_versions. NOT applied until promoted via Strategy Registry. Gated by phase gate, per-dim config, and auto-guard.", parameters: { type: "object", properties: { dimension: { type: "string", enum: ["fundamental_weight", "technical_weight", "sentiment_weight", "macro_weight", "insider_weight"] }, new_weight: { type: "number", minimum: 0.05, maximum: 0.60 }, reason: { type: "string" }, n_trades: { type: "integer", minimum: 10 }, confidence: { type: "number", minimum: 0, maximum: 1 } }, required: ["dimension", "new_weight", "reason", "n_trades", "confidence"] } },
        { name: "query_trade_decisions", description: "Query enriched real trade history (CSV imports + Robinhood MCP). Returns outcome_score per trade (positive=good decision), regime breakdown, win/loss counts. Use to find behavioral patterns in the user's actual trading history.", parameters: { type: "object", properties: { limit: { type: "number", description: "Max trades to return (default 50)" }, action: { type: "string", enum: ["buy", "sell"], description: "Filter by buy or sell" }, regime: { type: "string", description: "Filter by macro regime name (partial match)" }, min_outcome_score: { type: "number", description: "Filter decisions with outcome_score >= this" }, max_outcome_score: { type: "number", description: "Filter decisions with outcome_score <= this" } } } },
        { name: "semantic_search_decisions", description: "Vector similarity search over enriched trade decisions using Voyage AI embeddings. Use to find trades similar to a situation ('tech sell-off Q4', 'rate hike momentum trade', 'earnings miss hold'), or to answer 'what did I do when X happened'. Returns top-K decisions with outcome data. Only works if embeddings have been built (POST /api/live-portfolio/embed).", parameters: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 2000, description: "Natural language query describing the trade situation to search for" }, top_k: { type: "integer", minimum: 1, maximum: 20, description: "Number of results to return (default 8, max 20)" } }, required: ["query"] } },
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
          pause_reason: autoGuardTripped ? "Auto-guard: win_rate < 35% for 3 consecutive runs" : null,
        }, { onConflict: "run_date" });

        learnerResult = { summary: finishArgs.summary, hypotheses, weightMutations, steps: loopResult.steps, tokensIn: loopResult.tokensIn, tokensOut: loopResult.tokensOut, autoGuardTripped };
      } catch (agentErr) {
        console.error("[learner] agent loop failed:", agentErr);
        await svc.from("learner_runs").upsert({
          run_date: today,
          signals_analyzed: signalCount ?? 0,
          trades_analyzed: outcomes.length,
          mermaid_per_run: `flowchart TD\n  ERROR["❌ Agent loop error\\n${String(agentErr).slice(0, 100)}"]`,
          model_used: agentModel, tokens_in: 0, tokens_out: 0,
        }, { onConflict: "run_date" });
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
