import { canonicalize } from "@/lib/analytics/alpha-diagnostic-contract";
import { validateAttributionRow, type UpgradePathAttributionRow } from "@/lib/shadows/attribution";

type AttributionInsert = Omit<UpgradePathAttributionRow, "created_at">;
const KEY_COLUMNS = ["program_id", "market", "program_version", "baseline_version", "as_of_session"] as const;
const IMMUTABLE_COLUMNS = [
  "program_id", "market", "program_version", "baseline_version", "comparison_type", "state", "as_of_session",
  "window_start", "window_end", "baseline_portfolio_return_pct", "variant_portfolio_return_pct",
  "baseline_net_portfolio_return_pct", "variant_net_portfolio_return_pct", "benchmark_return_pct",
  "incremental_return_pct", "net_incremental_return_pct", "benchmark_relative_incremental_return_pct",
  "drawdown_delta_pct", "turnover_pct", "independent_sessions", "ci_lower_pct", "ci_upper_pct", "t_statistic",
  "matched_population_hash", "input_snapshot_hash", "cost_model_version", "validity_reason", "constraints",
] as const;
const NUMERIC_COLUMNS = new Set<string>([
  "baseline_portfolio_return_pct", "variant_portfolio_return_pct", "baseline_net_portfolio_return_pct",
  "variant_net_portfolio_return_pct", "benchmark_return_pct", "incremental_return_pct",
  "net_incremental_return_pct", "benchmark_relative_incremental_return_pct", "drawdown_delta_pct",
  "turnover_pct", "independent_sessions", "ci_lower_pct", "ci_upper_pct", "t_statistic",
]);

function projection(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(IMMUTABLE_COLUMNS.map((key) => {
    const raw = value[key];
    if (NUMERIC_COLUMNS.has(key) && raw != null) {
      const numeric = Number(raw);
      return [key, Number.isFinite(numeric) ? numeric : raw];
    }
    return [key, raw ?? null];
  }));
}

/** Append-only, retry-safe writer: a unique-key retry is accepted only when every persisted result field matches. */
export async function writeAttributionRow(client: any, row: AttributionInsert): Promise<"inserted" | "already_present"> {
  const validation = validateAttributionRow(row);
  if (!validation.valid || row.state !== "measured") {
    throw new Error(`Refusing non-measured or invalid attribution: ${validation.reasons.join(" ") || row.state}`);
  }
  const findExisting = () => {
    let query = client.from("upgrade_path_attribution_runs").select("*");
    for (const key of KEY_COLUMNS) query = query.eq(key, row[key]);
    return query.maybeSingle();
  };
  const { data: existing, error: readError } = await findExisting();
  if (readError) throw new Error(`Attribution idempotency lookup failed: ${readError.message}`);
  if (existing) {
    if (canonicalize(projection(existing)) === canonicalize(projection(row))) return "already_present";
    throw new Error("Conflicting immutable attribution already exists for this program/version/session.");
  }
  const { error } = await client.from("upgrade_path_attribution_runs").insert(row);
  if (!error) return "inserted";
  const { data: concurrent, error: retryReadError } = await findExisting();
  if (!retryReadError && concurrent && canonicalize(projection(concurrent)) === canonicalize(projection(row))) return "already_present";
  throw new Error(`Attribution append failed: ${error.message}`);
}
