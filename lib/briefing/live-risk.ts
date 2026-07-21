import { marketSessionsSince } from "@/lib/trading/paper-exit-policy";

export type BriefingMarket = "us" | "india";
export type LiveRiskState = "available" | "no_complete_runs" | "unavailable";

export interface LiveRiskRunRow {
  id: string;
  market: string;
  currency: string;
  broker: string;
  account_id: string;
  account_label: string | null;
  status: string;
  captured_on: string;
  source_captured_at: string | null;
  completed_at: string | null;
  formula_version: string;
  data_confidence: number | null;
  missing_inputs: string[] | null;
}

export interface LiveRiskHoldingRow {
  run_id: string;
  market: string;
  currency: string;
  account_id: string;
  symbol: string;
  current_price: number | null;
  market_value: number | null;
  weight_pct: number | null;
  unrealized_pnl_pct: number | null;
  holding_risk_score: number | null;
  risk_label: string | null;
  risk_posture: string | null;
  action_reason: string | null;
  data_confidence: number | null;
  missing_inputs: string[] | null;
}

export interface LiveRiskAccountRow {
  run_id: string;
  market: string;
  currency: string;
  account_id: string;
  total_value: number | null;
  metrics: Record<string, unknown> | null;
  data_confidence: number | null;
  missing_inputs: string[] | null;
}

export interface BriefingRiskHolding {
  symbol: string;
  currentPrice: number | null;
  marketValue: number | null;
  weightPct: number | null;
  unrealizedPnlPct: number | null;
  score: number | null;
  label: string | null;
  posture: "exit_review" | "trim" | "review" | "insufficient_data" | "hold";
  reason: string | null;
  dataConfidence: number | null;
  missingInputs: string[];
}

export interface BriefingRiskAccount {
  accountId: string;
  accountLabel: string;
  broker: string;
  currency: "USD" | "INR";
  capturedOn: string;
  sourceCapturedAt: string | null;
  formulaVersion: string;
  dataConfidence: number | null;
  missingInputs: string[];
  sessionsOld: number | null;
  stale: boolean;
  totalValue: number | null;
  accountRiskScore: number | null;
  accountRiskLabel: string | null;
  holdingsTotal: number;
  holdingsShown: BriefingRiskHolding[];
  holdingsOmitted: number;
}

export interface LiveRiskBriefing {
  state: LiveRiskState;
  accounts: BriefingRiskAccount[];
  error: string | null;
}

const POSTURE_RANK: Record<BriefingRiskHolding["posture"], number> = {
  exit_review: 5,
  trim: 4,
  review: 3,
  insufficient_data: 2,
  hold: 1,
};

function finiteNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function promptField(value: unknown, maxLength = 240): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizePosture(value: string | null): BriefingRiskHolding["posture"] {
  switch (value) {
    case "exit_review":
    case "trim":
    case "review":
    case "insufficient_data":
      return value;
    default:
      return "hold";
  }
}

function runTimestamp(run: LiveRiskRunRow): number {
  const value = run.completed_at ?? `${run.captured_on}T00:00:00Z`;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function accountDisplayLabel(run: LiveRiskRunRow): string {
  const fallback = `${run.broker} ••••${run.account_id.slice(-4)}`;
  if (!run.account_label) return fallback;
  const masked = run.account_label.split(run.account_id).join(`••••${run.account_id.slice(-4)}`);
  return masked.trim() || fallback;
}

export function latestCompleteRiskRuns(
  rows: readonly LiveRiskRunRow[],
  market: BriefingMarket,
): LiveRiskRunRow[] {
  const expectedCurrency = market === "india" ? "INR" : "USD";
  const sorted = rows
    // `internal` is the paper-book adapter. HoldingRisk computes it for the Risk
    // page, but a section explicitly labelled LIVE must never present it as a
    // broker account.
    .filter((row) => row.status === "complete"
      && row.market === market
      && row.currency === expectedCurrency
      && row.broker !== "internal")
    .slice()
    .sort((a, b) => runTimestamp(b) - runTimestamp(a));
  const latest = new Map<string, LiveRiskRunRow>();
  for (const row of sorted) {
    if (!latest.has(row.account_id)) latest.set(row.account_id, row);
  }
  return Array.from(latest.values());
}

export function buildLiveRiskBriefing(input: {
  market: BriefingMarket;
  now: Date;
  runs: readonly LiveRiskRunRow[];
  holdings: readonly LiveRiskHoldingRow[];
  accounts: readonly LiveRiskAccountRow[];
  error?: string | null;
}): LiveRiskBriefing {
  if (input.error) return { state: "unavailable", accounts: [], error: input.error };

  const runs = latestCompleteRiskRuns(input.runs, input.market);
  if (runs.length === 0) return { state: "no_complete_runs", accounts: [], error: null };

  const accountByRun = new Map(input.accounts.map((row) => [row.run_id, row]));
  const accounts = runs.map((run): BriefingRiskAccount => {
    const rollup = accountByRun.get(run.id);
    const consistentRollup = rollup?.market === run.market
      && rollup.currency === run.currency
      && rollup.account_id === run.account_id
      ? rollup
      : null;

    const allHoldings = input.holdings
      .filter((row) => row.run_id === run.id
        && row.market === run.market
        && row.currency === run.currency
        && row.account_id === run.account_id)
      .map((row): BriefingRiskHolding => ({
        symbol: row.symbol,
        currentPrice: finiteNumber(row.current_price),
        marketValue: finiteNumber(row.market_value),
        weightPct: finiteNumber(row.weight_pct),
        unrealizedPnlPct: finiteNumber(row.unrealized_pnl_pct),
        score: finiteNumber(row.holding_risk_score),
        label: row.risk_label,
        posture: normalizePosture(row.risk_posture),
        reason: row.action_reason,
        dataConfidence: finiteNumber(row.data_confidence),
        missingInputs: row.missing_inputs ?? [],
      }))
      .sort((a, b) => POSTURE_RANK[b.posture] - POSTURE_RANK[a.posture]
        || (b.score ?? -1) - (a.score ?? -1)
        || a.symbol.localeCompare(b.symbol));

    // A daily email is an attention surface, not a second portfolio page. Never
    // omit an actionable/review row; add the three highest-risk ordinary holds.
    const attention = allHoldings.filter((holding) => holding.posture !== "hold");
    const ordinary = allHoldings.filter((holding) => holding.posture === "hold").slice(0, 3);
    const shownSymbols = new Set([...attention, ...ordinary].map((holding) => holding.symbol));
    const shown = allHoldings.filter((holding) => shownSymbols.has(holding.symbol));

    const freshnessSource = run.source_captured_at ?? `${run.captured_on}T12:00:00Z`;
    const rawSessionsOld = marketSessionsSince(freshnessSource, input.now, input.market);
    const sessionsOld = Number.isFinite(rawSessionsOld) ? rawSessionsOld : null;
    const metrics = consistentRollup?.metrics ?? null;

    return {
      accountId: run.account_id,
      accountLabel: accountDisplayLabel(run),
      broker: run.broker,
      currency: run.currency as "USD" | "INR",
      capturedOn: run.captured_on,
      sourceCapturedAt: run.source_captured_at,
      formulaVersion: run.formula_version,
      dataConfidence: finiteNumber(run.data_confidence),
      missingInputs: run.missing_inputs ?? [],
      sessionsOld,
      stale: sessionsOld == null || sessionsOld > 1,
      totalValue: finiteNumber(consistentRollup?.total_value),
      accountRiskScore: finiteNumber(metrics?.riskScore),
      accountRiskLabel: typeof metrics?.riskLabel === "string" ? metrics.riskLabel : null,
      holdingsTotal: allHoldings.length,
      holdingsShown: shown,
      holdingsOmitted: Math.max(0, allHoldings.length - shown.length),
    };
  });

  return { state: "available", accounts, error: null };
}

export function liveRiskContextLines(risk: LiveRiskBriefing): string[] {
  if (risk.state === "unavailable") return ["  - Live holding risk unavailable; do not infer a safe posture."];
  if (risk.state === "no_complete_runs") return ["  - No completed live holding-risk run exists for this market."];
  return risk.accounts.flatMap((account) => {
    const freshness = account.stale
      ? `STALE (${account.sessionsOld == null ? "age unknown" : `${account.sessionsOld} sessions old`})`
      : `current (${account.sessionsOld} sessions old)`;
    const header = `  - ${promptField(account.accountLabel, 80)} [${account.currency}], ${freshness}, account risk ${account.accountRiskScore ?? "unavailable"}${account.accountRiskLabel ? `/${promptField(account.accountRiskLabel, 40)}` : ""}`;
    const holdings = account.holdingsShown.map((holding) =>
      `    - ${promptField(holding.symbol, 24)}: ${holding.posture}, risk ${holding.score ?? "unavailable"}${holding.reason ? `; ${promptField(holding.reason)}` : ""}`,
    );
    if (account.holdingsOmitted > 0) holdings.push(`    - ${account.holdingsOmitted} lower-priority hold(s) omitted from the briefing; see Risk Analytics.`);
    return [header, ...holdings];
  });
}
