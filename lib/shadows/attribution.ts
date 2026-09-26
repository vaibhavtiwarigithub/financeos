/**
 * Shared contract for an Upgrade Path performance claim.  This deliberately
 * validates the comparison rather than calculating a return from unrelated
 * portfolio history: a path is allowed to say "measured" only when its own
 * baseline and variant are comparable.
 */
export type AttributionClass = "matched_replay" | "paper_cohort" | "operational_only";
export type AttributionState = "measured" | "collecting" | "producer_missing" | "not_attributable" | "invalid";

export interface UpgradePathAttributionRow {
  program_id: string;
  market: "us" | "india";
  program_version: string;
  baseline_version: string;
  comparison_type: AttributionClass;
  state: AttributionState;
  as_of_session: string;
  window_start: string | null;
  window_end: string | null;
  baseline_portfolio_return_pct: number | null;
  variant_portfolio_return_pct: number | null;
  baseline_net_portfolio_return_pct: number | null;
  variant_net_portfolio_return_pct: number | null;
  benchmark_return_pct: number | null;
  incremental_return_pct: number | null;
  net_incremental_return_pct: number | null;
  benchmark_relative_incremental_return_pct: number | null;
  drawdown_delta_pct: number | null;
  turnover_pct: number | null;
  independent_sessions: number | null;
  ci_lower_pct: number | null;
  ci_upper_pct: number | null;
  t_statistic: number | null;
  matched_population_hash: string | null;
  input_snapshot_hash: string | null;
  cost_model_version: string | null;
  validity_reason: string | null;
  constraints: Record<string, unknown>;
  created_at?: string;
}

export interface AttributionValidation {
  valid: boolean;
  reasons: string[];
}

const EPSILON = 0.000001;
const isFiniteNumber = (value: number | null): value is number => value != null && Number.isFinite(value);
const hasText = (value: string | null | undefined) => typeof value === "string" && value.trim().length > 0;

/**
 * A measured claim must have enough provenance to be independently repeated.
 * It intentionally does not decide whether an effect is economically useful or
 * statistically significant; individual programs predeclare those gates.
 */
export function validateAttributionRow(row: UpgradePathAttributionRow): AttributionValidation {
  const reasons: string[] = [];
  if (!hasText(row.program_id) || !hasText(row.program_version) || !hasText(row.baseline_version)) reasons.push("Program and baseline versions are required.");
  if (!hasText(row.as_of_session)) reasons.push("An as-of market session is required.");
  if (row.state !== "measured") return { valid: row.state !== "invalid", reasons: row.state === "invalid" && !hasText(row.validity_reason) ? ["Invalid rows must explain why."] : reasons };
  if (row.comparison_type === "operational_only") reasons.push("Operational-only paths cannot claim portfolio performance.");
  if (!row.window_start || !row.window_end || row.window_end < row.window_start) reasons.push("A valid common evaluation window is required.");
  if (!hasText(row.matched_population_hash) || !hasText(row.input_snapshot_hash)) reasons.push("Matched population and point-in-time input hashes are required.");
  if (!hasText(row.cost_model_version)) reasons.push("A cost-model version is required.");
  if (row.constraints.same_market !== true || row.constraints.same_window !== true || row.constraints.same_population !== true || row.constraints.non_overlapping_sessions !== true || row.constraints.cost_basis !== "net") reasons.push("The row must attest to same-market, same-window, same-population, non-overlapping, net-of-cost comparison constraints.");
  if (!isFiniteNumber(row.baseline_portfolio_return_pct) || !isFiniteNumber(row.variant_portfolio_return_pct) || !isFiniteNumber(row.incremental_return_pct) || !isFiniteNumber(row.net_incremental_return_pct)) reasons.push("Baseline, variant, gross incremental, and net incremental returns are required.");
  if (!isFiniteNumber(row.benchmark_return_pct) || !isFiniteNumber(row.benchmark_relative_incremental_return_pct)) reasons.push("Same-window benchmark comparison is required.");
  if (!isFiniteNumber(row.turnover_pct) || !isFiniteNumber(row.drawdown_delta_pct)) reasons.push("Turnover and drawdown delta are required.");
  if (!Number.isInteger(row.independent_sessions) || (row.independent_sessions ?? 0) < 2) reasons.push("At least two non-overlapping independent return blocks are required.");
  if (!isFiniteNumber(row.ci_lower_pct) || !isFiniteNumber(row.ci_upper_pct) || row.ci_lower_pct! > row.ci_upper_pct!) reasons.push("A valid confidence interval is required.");
  if (isFiniteNumber(row.baseline_portfolio_return_pct) && isFiniteNumber(row.variant_portfolio_return_pct) && isFiniteNumber(row.incremental_return_pct)
    && Math.abs((row.variant_portfolio_return_pct - row.baseline_portfolio_return_pct) - row.incremental_return_pct) > EPSILON) reasons.push("Incremental return must equal variant minus baseline on the common window.");
  if (!isFiniteNumber(row.baseline_net_portfolio_return_pct) || !isFiniteNumber(row.variant_net_portfolio_return_pct)) reasons.push("Both baseline and variant net returns are required to verify net attribution.");
  if (isFiniteNumber(row.baseline_net_portfolio_return_pct) && isFiniteNumber(row.variant_net_portfolio_return_pct) && isFiniteNumber(row.net_incremental_return_pct)
    && Math.abs((row.variant_net_portfolio_return_pct - row.baseline_net_portfolio_return_pct) - row.net_incremental_return_pct) > EPSILON) reasons.push("Net incremental return must equal variant net minus baseline net on the common window.");
  return { valid: reasons.length === 0, reasons };
}

export function defaultAttribution(classification: AttributionClass): Pick<UpgradePathAttributionRow, "comparison_type" | "state" | "validity_reason"> {
  return classification === "operational_only"
    ? { comparison_type: classification, state: "not_attributable", validity_reason: "This is an operational or descriptive path; a portfolio-return claim would not isolate a trading decision." }
    : { comparison_type: classification, state: "producer_missing", validity_reason: "No verified scheduled portfolio-level baseline/variant producer is registered for this path; evidence is not collecting until one is implemented and verified." };
}
