// Read-only projection of persisted research and PaperTrader evidence.
// Never imported by a money path. One entry-candidate decision per symbol and
// session, chosen before looking at subsequent stage or return evidence.
import { isEligibleLong, resolveDecisionContext } from "@/lib/learning/entry-cohort";
import type { FunnelRow } from "@/lib/analytics/alpha-diagnostics";

export interface FunnelObservation {
  id: string | number;
  signal_id: string | null;
  symbol: string;
  ts: string;
  entry_eligible: boolean | null;
  direction: string | null;
  decision_context: string | null;
  discovery_source: string | null;
  observation_labels: Array<{ horizon_days: number; benchmark_neutral_return: number | null }> | null;
}

export interface FunnelSignal {
  version: string;
  session: string | null;
}

export interface FunnelEvent {
  signal_id: string | null;
  stage: string;
  outcome: string;
  reason: string | null;
  created_at: string;
}

export interface FunnelTrade {
  signal_id: string | null;
  executed_at: string | null;
  closed_at: string | null;
  tainted: boolean | null;
  excluded_from_learning: boolean | null;
}

function entryDecision(observation: FunnelObservation, signals: Map<string, FunnelSignal>): { date: string; key: string } | null {
  if (resolveDecisionContext(observation.decision_context, observation.discovery_source) !== "entry_candidate") return null;
  const source = observation.signal_id ? signals.get(observation.signal_id) : null;
  const date = source?.session;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return { date, key: `${date}|${observation.symbol}` };
}

function earlier(a: FunnelObservation, b: FunnelObservation): boolean {
  return String(a.ts) < String(b.ts)
    || (a.ts === b.ts && String(a.id) < String(b.id));
}

function labelAt(observation: FunnelObservation, horizonDays: number): number | null {
  const labels = Array.isArray(observation.observation_labels) ? observation.observation_labels : [];
  const raw = labels.find(label => Number(label.horizon_days) === horizonDays)?.benchmark_neutral_return;
  if (raw == null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** First scored entry decision per symbol/session, regardless of eligibility. */
export function projectAllScoredEntryRows(
  observations: FunnelObservation[], signals: Map<string, FunnelSignal>, horizonDays: number,
): FunnelRow[] {
  const first = new Map<string, FunnelObservation>();
  for (const observation of observations) {
    const decision = entryDecision(observation, signals);
    if (!decision) continue;
    const prior = first.get(decision.key);
    if (!prior || earlier(observation, prior)) first.set(decision.key, observation);
  }
  return [...first.values()].map(observation => ({
    date: signals.get(observation.signal_id!)!.session!, symbol: observation.symbol,
    stage: "scored", benchmarkNeutralReturn: labelAt(observation, horizonDays),
    attritionReason: null,
  }));
}

const TRADER_STAGES = new Set([
  "portfolio_constructor", "sector_gate", "reentry_gate", "pricing",
  "existing_position_gate", "risk_plan", "trade_plan", "sizing", "execution",
  "capital_rotation",
]);

/** All inputs must have been filtered to the same market by the caller. */
export function projectEntryFunnel(
  observations: FunnelObservation[],
  signals: Map<string, FunnelSignal>,
  events: FunnelEvent[],
  trades: FunnelTrade[],
  horizonDays: number,
): FunnelRow[] {
  const earliestEligible = new Map<string, FunnelObservation>();
  for (const observation of observations) {
    const decision = entryDecision(observation, signals);
    if (!decision || !isEligibleLong(observation.entry_eligible, observation.direction)) continue;
    const prior = earliestEligible.get(decision.key);
    if (!prior || earlier(observation, prior)) earliestEligible.set(decision.key, observation);
  }

  const bySignalEvents = new Map<string, FunnelEvent[]>();
  for (const event of events) {
    if (!event.signal_id || !TRADER_STAGES.has(event.stage)) continue;
    bySignalEvents.set(event.signal_id, [...(bySignalEvents.get(event.signal_id) ?? []), event]);
  }
  const bySignalTrades = new Map<string, FunnelTrade[]>();
  for (const trade of trades) {
    if (!trade.signal_id || trade.tainted === true || trade.excluded_from_learning === true) continue;
    bySignalTrades.set(trade.signal_id, [...(bySignalTrades.get(trade.signal_id) ?? []), trade]);
  }

  return [...earliestEligible.values()].map(observation => {
    const signalId = observation.signal_id!;
    const date = signals.get(signalId)!.session!;
    const decisionEvents = (bySignalEvents.get(signalId) ?? [])
      .filter(event => event.created_at.slice(0, 10) === date && event.created_at >= observation.ts)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    const lotRows = (bySignalTrades.get(signalId) ?? [])
      .filter(trade => trade.executed_at?.slice(0, 10) === date);
    const selected = decisionEvents.length > 0 || lotRows.length > 0;
    const filled = lotRows.length > 0;
    const closed = filled && lotRows.every(trade => trade.closed_at != null);
    const stage: FunnelRow["stage"] = closed ? "closed" : filled ? "filled" : selected ? "selected" : "entry_eligible";
    const lastBlock = [...decisionEvents].reverse().find(event =>
      event.outcome === "rejected" || event.outcome === "deferred" || event.outcome === "unavailable");
    return {
      date,
      symbol: observation.symbol,
      stage,
      benchmarkNeutralReturn: labelAt(observation, horizonDays),
      attritionReason: !selected ? "not_selected_or_stage_unrecorded"
        : !filled ? (lastBlock?.reason ?? "selected_without_fill_reason")
        : !closed ? "open_position" : null,
    };
  });
}
