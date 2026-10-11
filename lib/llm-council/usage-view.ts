export type CouncilUsageRecord = {
  usage_date: string;
  market: "us" | "india" | string;
  execution_source: "api" | "subscription" | string;
  model_requested: string;
  model_actual: string;
  role: string;
  record_count: number | string;
  failure_count: number | string;
  input_tokens: number | string;
  output_tokens: number | string;
  input_unknown_records: number | string;
  output_unknown_records: number | string;
  estimated_api_cost_usd: number | string | null;
  lease_attempts: number | string;
  timestamp_basis: string;
};

export type CouncilUsageDetail = {
  modelRequested: string;
  modelActual: string;
  role: string;
  records: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  inputUnknownRecords: number;
  outputUnknownRecords: number;
  estimatedApiCostUsd: number | null;
  leaseAttempts: number;
  timestampBasis: string;
};

export type CouncilUsageDay = {
  usageDate: string;
  market: string;
  executionSource: string;
  records: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  inputUnknownRecords: number;
  outputUnknownRecords: number;
  estimatedApiCostUsd: number | null;
  leaseAttempts: number;
  timestampBasis: string;
  details: CouncilUsageDetail[];
};

const n = (value: number | string | null): number => {
  if (value == null) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export function groupCouncilUsageRows(rows: CouncilUsageRecord[]): CouncilUsageDay[] {
  const groups = new Map<string, CouncilUsageDay>();
  for (const row of rows) {
    const key = `${row.usage_date}\u0000${row.market}\u0000${row.execution_source}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        usageDate: row.usage_date,
        market: row.market,
        executionSource: row.execution_source,
        records: 0,
        failures: 0,
        inputTokens: 0,
        outputTokens: 0,
        inputUnknownRecords: 0,
        outputUnknownRecords: 0,
        estimatedApiCostUsd: row.execution_source === "api" ? 0 : null,
        leaseAttempts: 0,
        timestampBasis: row.timestamp_basis,
        details: [],
      };
      groups.set(key, group);
    } else if (group.timestampBasis !== row.timestamp_basis) {
      group.timestampBasis = "mixed timestamp bases";
    }

    const detail: CouncilUsageDetail = {
      modelRequested: row.model_requested,
      modelActual: row.model_actual,
      role: row.role,
      records: n(row.record_count),
      failures: n(row.failure_count),
      inputTokens: n(row.input_tokens),
      outputTokens: n(row.output_tokens),
      inputUnknownRecords: n(row.input_unknown_records),
      outputUnknownRecords: n(row.output_unknown_records),
      estimatedApiCostUsd: row.estimated_api_cost_usd == null ? null : n(row.estimated_api_cost_usd),
      leaseAttempts: n(row.lease_attempts),
      timestampBasis: row.timestamp_basis,
    };
    group.records += detail.records;
    group.failures += detail.failures;
    group.inputTokens += detail.inputTokens;
    group.outputTokens += detail.outputTokens;
    group.inputUnknownRecords += detail.inputUnknownRecords;
    group.outputUnknownRecords += detail.outputUnknownRecords;
    group.leaseAttempts += detail.leaseAttempts;
    if (group.executionSource === "api") {
      if (detail.estimatedApiCostUsd == null) group.estimatedApiCostUsd = null;
      else if (group.estimatedApiCostUsd != null) group.estimatedApiCostUsd += detail.estimatedApiCostUsd;
    }
    group.details.push(detail);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      details: group.details.sort((a, b) => a.modelRequested.localeCompare(b.modelRequested) || a.role.localeCompare(b.role)),
    }))
    .sort((a, b) => b.usageDate.localeCompare(a.usageDate) || a.market.localeCompare(b.market) || a.executionSource.localeCompare(b.executionSource));
}
