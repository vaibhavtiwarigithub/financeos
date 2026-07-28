import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { computeExitFillPrice } from "@/lib/data/quotes";

const read = (path: string) => readFileSync(path, "utf8");

describe("agent source pipeline remediation", () => {
  it("applies conservative paper sell slippage", () => {
    expect(computeExitFillPrice(100)).toBe(99.95);
    expect(computeExitFillPrice(100, 99)).toBe(98.9505);
  });

  it("batches market-local PositionMonitor prices and exposes unevaluated names", () => {
    const route = read("app/api/agents/position-monitor/route.ts");
    expect(route).toContain("getBatchQuotes(usSymbols, svc)");
    expect(route).toContain("fetchIndiaQuotes(indiaSymbols)");
    expect(route).toContain('fetchYahooQuotes(unresolvedUs, "us")');
    expect(route).toContain("!q.stale");
    expect(route).toContain("position-monitor-price-unavailable:");
    expect(route).toContain("p_exit_price: exitFillPrice");
    expect(route).not.toContain("/v2/aggs/ticker/${sym}/prev");
  });

  it("reconciles ambiguous broker cancellations instead of retrying forever", () => {
    const maintenance = read("lib/trading/order-maintenance.ts");
    expect(maintenance).toContain("cancel not confirmed; reconciliation required");
    expect(maintenance).toContain('resolveIssue(`order-cancel-failed:${row.id}`');
  });

  it("retains bounded research retries and self-resolves per-market failures", () => {
    const cron = read("app/api/agents/research/cron/route.ts");
    const queue = read("lib/research-queue.ts");
    expect(queue).toContain("export async function completeDeferred");
    expect(queue).not.toContain('from("research_queue").delete().eq("market", market).in("symbol", batch)');
    expect(cron).toContain("await enqueueDeferred(supabase, queueMarket, failed)");
    expect(cron).toContain("await completeDeferred(supabase, queueMarket, completed)");
    expect(cron).toContain("research-symbol-failures:");
    expect(cron).toContain("await resolveIssue(failureIssueKey, supabase)");
  });

  it("scopes discovery before provider and broker work", () => {
    const agent = read("lib/research-agent.ts");
    const cron = read("app/api/agents/research/cron/route.ts");
    const prewarm = read("app/api/agents/prewarm/route.ts");
    expect(agent).toContain('includeUs ? fetchHoldings(supabase) : Promise.resolve([])');
    expect(agent).toContain('includeUs ? runScreener(supabase) : Promise.resolve([])');
    expect(agent).toContain("const indiaHeld = includeIndia");
    expect(agent).toContain('orderHoldingsByLastScored(supabase, await fetchIndiaHoldings(supabase), "india")');
    expect(cron).toContain("gatherSymbols(supabase, undefined, marketScope ?? undefined)");
    expect(prewarm).toContain("gatherSymbols(svc, undefined, market)");
  });

  it("keeps Theme Scout independent and AV-reserve-only", () => {
    const cron = read("app/api/agents/research/cron/route.ts");
    const scout = read("app/api/agents/theme-scout/route.ts");
    const migration = read("supabase/migrations/20260720124539_decouple_theme_scout.sql");
    expect(cron).not.toContain("/api/agents/theme-scout");
    expect(scout).toContain('providerCachedFetch(\n      "gdelt"');
    expect(scout).toContain('const movers = news ? "" : await fetchTopGainersLosers()');
    expect(scout).toContain("fetchUsOverview(symbol");
    expect(migration).toContain("kairos-theme-scout");
  });

  it("does not fetch unconsumed options and records winning provider provenance", () => {
    const agent = read("lib/research-agent.ts");
    const scores = read("lib/data/scores.ts");
    expect(agent).not.toContain("fetchOptionsSignal(");
    expect(agent).toContain("fundamental: fundamentalResult.source");
    expect(agent).toContain("technical: candleResult.source as SourceName");
    expect(agent).toContain('insider: insiderResult?.source ?? "unavailable"');
    expect(scores).toContain('source: opts.provenance?.fundamental ?? "unavailable"');
    expect(scores).toContain('source: opts.provenance?.technical ?? "unavailable"');
  });

  it("keeps risk annotation canonical and separate from risk decisions", () => {
    const riskApi = read("app/api/portfolio/risk-daily/route.ts");
    const engine = read("lib/risk/holding-risk.ts");
    expect(riskApi).toContain('.eq("score_source", "deterministic_v1")');
    expect(riskApi).toContain('.eq("session_validated", true)');
    expect(engine).not.toContain("agent_signals");
    expect(engine).not.toContain("analyst_score");
  });

  it("leaves Learner measure-only for open positions and isolates macro", () => {
    const learner = read("app/api/agents/learner/route.ts");
    const macro = read("app/api/agents/macro-sentinel/route.ts");
    expect(learner).not.toContain('update({ exit_reason: "score_reassess_exit"');
    expect(learner).not.toContain("price_target: newTarget");
    expect(learner).toContain('if (LEARN_MARKET === "india")');
    expect(learner).toContain("structurally inapplicable to the India learner cohort");
    expect(macro).toContain('.select("id, regime, raw_indicators")');
    expect(macro).toContain("existingIndicatorCount >= 3");
  });

  it("keeps dormant autonomous live market-local", () => {
    const live = read("lib/trading/autonomous-live.ts");
    expect(live).toContain("loadTradingMandateStrict(svc");
    expect(live).toContain('.eq("market", market)');
    expect(live).toContain("fetchIndiaQuote(signal.symbol)");
    expect(live).toContain("priceStale = quote?.stale ?? true");
    expect(live).toContain("calibrationByMarket[market]");
  });

  it("reports only fresh rotating India scanner coverage", () => {
    const scan = read("app/api/scan/india/route.ts");
    const migration = read("supabase/migrations/20260720124528_india_quality_dimensions.sql");
    expect(scan).toContain("fresh_eligible_rows");
    expect(scan).toContain('coverage_mode: "rotating_fresh_slice"');
    expect(scan).toContain('.gte("scored_at", freshCutoff)');
    expect(migration).toContain("ARRAY['fundamental'::text, 'technical'::text, 'sentiment'::text]");
  });
});
