import { MODELED_SLIP_FRACTION } from "@/lib/analytics/performance-metrics";
import type { Candle } from "@/lib/data/technicals";
import { compileSpec, type Bar } from "./compile";
import type { RuleSpec } from "./rule-spec";

export const TEMPLATE_SHADOW_COLLECTOR_VERSION = "template-shadow-forward-v1";
export const TEMPLATE_SHADOW_PRICE_PROVENANCE = "completed-research-candle-v1";

export function priceBasisForResearchSource(source: string): "adjusted" | "raw" | "unknown" {
  switch (source.toLowerCase()) {
    case "yahoo": case "massive": case "eodhd": case "alphavantage": case "alpha_vantage": return "adjusted";
    case "upstox": return "raw";
    default: return "unknown";
  }
}

export interface TemplateShadowCollectorInput {
  supabase: any;
  market: "us" | "india";
  symbol: string;
  candles: readonly Candle[];
  source: string;
  observationId: number | null;
  baselineEntryEligible: boolean;
}

export interface TemplateShadowCollectorResult {
  activeConfigs: number;
  decisionsInserted: number;
  outcomesInserted: number;
  skippedForWarmup: number;
  skippedForBasisMismatch: number;
}

/** Called only by the natural market research producer; it cannot affect a trade. */
export async function collectTemplateShadowEvidence(input: TemplateShadowCollectorInput): Promise<TemplateShadowCollectorResult> {
  const out: TemplateShadowCollectorResult = {
    activeConfigs: 0, decisionsInserted: 0, outcomesInserted: 0,
    skippedForWarmup: 0, skippedForBasisMismatch: 0,
  };
  const { data: configs, error: configError } = await input.supabase
    .from("strategy_template_shadow_configs")
    .select("id,strategy_version_id,rule_spec,rule_version")
    .eq("market", input.market).eq("state", "shadow").limit(3);
  if (configError) throw new Error(`template shadow config read failed: ${configError.message}`);
  for (const config of (configs ?? []) as Array<{ id: string; strategy_version_id: number; rule_spec: RuleSpec; rule_version: string }>) {
    const symbol = input.symbol.trim().toUpperCase();
    if (!Array.isArray(config.rule_spec?.universe) || !config.rule_spec.universe.some((item) => String(item).trim().toUpperCase() === symbol)) continue;
    out.activeConfigs++;
    if (config.rule_spec.market !== input.market) throw new Error(`template shadow market mismatch for config ${config.id}`);
    const basis = priceBasisForResearchSource(input.source);
    if (basis === "unknown") throw new Error(`template shadow source has no approved price basis for ${input.market}/${symbol}`);
    if (input.candles.length < 2) throw new Error(`template shadow needs at least two completed candles for ${input.market}/${symbol}`);
    const bars = normalizeBars(input.candles);
    if (!validBars(bars, input.candles.length)) throw new Error(`template shadow received invalid completed candles for ${input.market}/${symbol}`);
    const latest = bars[bars.length - 1];
    const compiled = compileSpec({ spec: config.rule_spec, bars: { [symbol]: bars }, initialCash: 100_000 });
    if (compiled.errors.length) throw new Error(`template shadow rule invalid ${config.id}: ${compiled.errors.join("; ")}`);
    const decision = compiled.decisions.find((row) => row.symbol === symbol && row.session === latest.session);
    if (!decision) { out.skippedForWarmup++; continue; }
    const { data: writtenDecision, error: decisionError } = await input.supabase.from("strategy_template_shadow_decisions").upsert({
      config_id: config.id,
      strategy_version_id: config.strategy_version_id,
      market: input.market,
      symbol,
      signal_session: latest.session,
      observation_id: input.observationId,
      would_enter: decision.wouldEnter,
      baseline_entry_eligible: input.baselineEntryEligible,
      decision_close: latest.close,
      decision_price_basis: basis,
      decision_provenance: TEMPLATE_SHADOW_PRICE_PROVENANCE,
      compiler_version: config.rule_version,
      data_source: input.source,
    }, { onConflict: "config_id,symbol,signal_session", ignoreDuplicates: true }).select("id");
    if (decisionError) throw new Error(`template shadow decision write failed: ${decisionError.message}`);
    if ((writtenDecision ?? []).length) out.decisionsInserted++;

    const { data: pending, error: pendingError } = await input.supabase.from("strategy_template_shadow_decisions")
      .select("id,signal_session,decision_price_basis").eq("config_id", config.id).eq("symbol", symbol)
      .order("signal_session", { ascending: false }).limit(750);
    if (pendingError) throw new Error(`template shadow pending read failed: ${pendingError.message}`);
    const pendingRows = pending ?? [];
    const ids = pendingRows.map((row: any) => row.id);
    if (!ids.length) continue;
    const { data: labeled, error: labelsError } = await input.supabase.from("strategy_template_shadow_outcomes")
      .select("decision_id").in("decision_id", ids);
    if (labelsError) throw new Error(`template shadow outcome lookup failed: ${labelsError.message}`);
    const alreadyLabeled = new Set((labeled ?? []).map((row: any) => Number(row.decision_id)));
    for (const pendingRow of pendingRows) {
      if (alreadyLabeled.has(Number(pendingRow.id))) continue;
      if (pendingRow.decision_price_basis !== basis) { out.skippedForBasisMismatch++; continue; }
      const signalIndex = bars.findIndex((bar) => bar.session === String(pendingRow.signal_session).slice(0,10));
      const entryIndex = signalIndex + 1;
      const exitIndex = entryIndex + config.rule_spec.horizonSessions;
      if (signalIndex < 0 || exitIndex >= bars.length) continue;
      const entry = bars[entryIndex], exit = bars[exitIndex];
      if (!(entry.open > 0 && exit.open > 0)) continue;
      const grossReturn = (exit.open / entry.open - 1) * 100;
      const netReturn = ((exit.open * (1 - MODELED_SLIP_FRACTION)) / (entry.open * (1 + MODELED_SLIP_FRACTION)) - 1) * 100;
      const { data: writtenOutcome, error: outcomeError } = await input.supabase.from("strategy_template_shadow_outcomes").upsert({
        decision_id: pendingRow.id,
        entry_session: entry.session,
        exit_session: exit.session,
        entry_open: entry.open,
        exit_open: exit.open,
        gross_return_pct: grossReturn,
        net_return_pct: netReturn,
        modeled_cost_pct: MODELED_SLIP_FRACTION * 200,
        price_source: input.source,
        price_basis: basis,
        provenance_version: TEMPLATE_SHADOW_PRICE_PROVENANCE,
      }, { onConflict: "decision_id", ignoreDuplicates: true }).select("id");
      if (outcomeError) throw new Error(`template shadow outcome write failed: ${outcomeError.message}`);
      if ((writtenOutcome ?? []).length) out.outcomesInserted++;
    }
  }
  return out;
}

function normalizeBars(candles: readonly Candle[]): Bar[] {
  return candles.map((c) => ({ session: String(c.date).slice(0,10), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close) }))
    .sort((a,b) => a.session.localeCompare(b.session));
}

function validBars(bars: readonly Bar[], originalCount: number): boolean {
  if (bars.length !== originalCount) return false;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bar.session)
      || (i > 0 && bars[i - 1].session === bar.session)
      || ![bar.open, bar.high, bar.low, bar.close].every((value) => Number.isFinite(value) && value > 0)
      || bar.high < Math.max(bar.open, bar.low, bar.close)
      || bar.low > Math.min(bar.open, bar.high, bar.close)) return false;
  }
  return true;
}
