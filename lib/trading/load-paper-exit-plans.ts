import { loadTradingMandate, resolveHorizonDays, type TradingMarket } from "@/lib/trading-mandate";
import { loadChampionGenome } from "@/lib/validation/genome-live";
import { projectPaperExitPlan, resolvePaperPositionHorizon, type PaperExitPlan } from "@/lib/trading/paper-exit-plan";

type ResolvedMarketPlan = {
  entryThreshold: number;
  maxScoreAgeSessions: number;
  currentHorizonDays: number;
  currentHorizonSource: "user" | "champion";
  existingPositionsPolicy: "grandfather" | "apply";
};

export async function loadPaperExitPlans(
  supabase: any,
  positions: any[],
  now = new Date(),
): Promise<Record<string, PaperExitPlan>> {
  if (!positions.length) return {};

  const markets = Array.from(new Set(
    positions.map((position) => position.market === "india" ? "india" : "us"),
  )) as TradingMarket[];

  const marketPlans = new Map<TradingMarket, ResolvedMarketPlan>();
  await Promise.all(markets.map(async (market) => {
    const [mandate, champion] = await Promise.all([
      loadTradingMandate(supabase, market),
      loadChampionGenome(supabase, market),
    ]);
    const resolved = resolveHorizonDays(
      mandate,
      champion.source === "champion" ? champion.genome.horizon_days : null,
    );
    marketPlans.set(market, {
      entryThreshold: mandate.score_threshold,
      maxScoreAgeSessions: mandate.max_signal_age_sessions,
      currentHorizonDays: resolved.days,
      currentHorizonSource: resolved.source,
      existingPositionsPolicy: mandate.existing_positions_policy,
    });
  }));

  const { data: strategyConfig } = await supabase
    .from("strategy_config")
    .select("exit_hysteresis")
    .maybeSingle();
  const hysteresis = Number((strategyConfig as any)?.exit_hysteresis) || 15;

  const latestSignals = new Map<string, any>();
  await Promise.all(markets.map(async (market) => {
    const marketPositions = positions.filter((position) =>
      (position.market === "india" ? "india" : "us") === market,
    );
    const symbols = Array.from(new Set(marketPositions.map((position) => String(position.symbol))));
    if (!symbols.length) return;
    const openedTimes = marketPositions
      .map((position) => Date.parse(String(position.opened_at ?? position.created_at ?? "")))
      .filter(Number.isFinite);
    const oldestOpen = openedTimes.length ? new Date(Math.min(...openedTimes)).toISOString() : null;

    let query = supabase
      .from("agent_signals")
      .select("symbol,analyst_score,created_at")
      .eq("market", market)
      .in("symbol", symbols)
      .eq("score_source", "deterministic_v1")
      .eq("session_validated", true)
      .order("created_at", { ascending: false });
    if (oldestOpen) query = query.gte("created_at", oldestOpen);
    const { data, error } = await query;
    if (error) return;
    for (const signal of data ?? []) {
      const key = `${market}:${String(signal.symbol)}`;
      if (!latestSignals.has(key)) latestSignals.set(key, signal);
    }
  }));

  const plans: Record<string, PaperExitPlan> = {};
  for (const position of positions) {
    const market = (position.market === "india" ? "india" : "us") as TradingMarket;
    const defaults = marketPlans.get(market);
    if (!defaults) continue;

    const isHedge = position.position_role === "hedge";
    const horizon = resolvePaperPositionHorizon({
      storedHorizon: position.resolved_horizon_days,
      isHedge,
      existingPositionsPolicy: defaults.existingPositionsPolicy,
      currentHorizonDays: defaults.currentHorizonDays,
      currentHorizonSource: defaults.currentHorizonSource,
    });

    const plan = projectPaperExitPlan({
      position: { ...position, market },
      signal: latestSignals.get(`${market}:${String(position.symbol)}`) ?? null,
      entryThreshold: defaults.entryThreshold,
      hysteresis,
      maxScoreAgeSessions: defaults.maxScoreAgeSessions,
      horizonDays: horizon.days,
      horizonSource: horizon.source,
      now,
    });
    plans[plan.positionId] = plan;
  }

  return plans;
}
