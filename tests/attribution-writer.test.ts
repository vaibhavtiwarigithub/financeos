import { describe, expect, it } from "vitest";
import { writeAttributionRow } from "@/lib/shadows/attribution-writer";
import type { UpgradePathAttributionRow } from "@/lib/shadows/attribution";

const row: Omit<UpgradePathAttributionRow, "created_at"> = {
  program_id: "international-allocation", market: "us", program_version: "allocation-v1", baseline_version: "voo-v1",
  comparison_type: "matched_replay", state: "measured", as_of_session: "2026-09-25",
  window_start: "2022-01-03", window_end: "2026-09-25",
  baseline_portfolio_return_pct: 10, variant_portfolio_return_pct: 12,
  baseline_net_portfolio_return_pct: 10, variant_net_portfolio_return_pct: 11.5,
  benchmark_return_pct: 10, incremental_return_pct: 2, net_incremental_return_pct: 1.5,
  benchmark_relative_incremental_return_pct: 1.5, drawdown_delta_pct: -1, turnover_pct: 20,
  independent_sessions: 12, ci_lower_pct: -0.5, ci_upper_pct: 1.2, t_statistic: 1.9,
  matched_population_hash: "population-hash", input_snapshot_hash: "input-hash", cost_model_version: "cost-v1",
  validity_reason: "Synthetic test fixture.",
  constraints: { same_market: true, same_window: true, same_population: true, non_overlapping_sessions: true, cost_basis: "net" },
};

function fakeSupabase() {
  const records: Array<Record<string, unknown>> = [];
  return {
    records,
    client: {
      from() {
        let filters: Record<string, unknown> = {};
        return {
          select() {
            return {
              eq(key: string, value: unknown) {
                filters[key] = value;
                return this;
              },
              async maybeSingle() {
                return { data: records.find((item) => Object.entries(filters).every(([key, value]) => item[key] === value)) ?? null, error: null };
              },
            };
          },
          async insert(value: Record<string, unknown>) {
            if (records.some((item) => item.program_id === value.program_id && item.market === value.market && item.program_version === value.program_version && item.baseline_version === value.baseline_version && item.as_of_session === value.as_of_session)) {
              return { error: { message: "duplicate key" } };
            }
            records.push(Object.fromEntries(Object.entries(value).map(([key, field]) => [
              key,
              typeof field === "number" ? String(field) : field,
            ])));
            return { error: null };
          },
        };
      },
    },
  };
}

describe("append-only Upgrade Path attribution writer", () => {
  it("accepts identical retries, including database numeric strings, without duplicating", async () => {
    const store = fakeSupabase();
    expect(await writeAttributionRow(store.client, row)).toBe("inserted");
    expect(await writeAttributionRow(store.client, row)).toBe("already_present");
    expect(store.records).toHaveLength(1);
  });

  it("refuses to rewrite the same version/session key with changed measured output", async () => {
    const store = fakeSupabase();
    await writeAttributionRow(store.client, row);
    await expect(writeAttributionRow(store.client, { ...row, ci_lower_pct: -0.4 })).rejects.toThrow("Conflicting immutable attribution");
    expect(store.records).toHaveLength(1);
  });

  it("refuses invalid or non-measured rows before issuing a database write", async () => {
    const store = fakeSupabase();
    await expect(writeAttributionRow(store.client, { ...row, state: "invalid", validity_reason: null })).rejects.toThrow("Refusing non-measured or invalid");
    expect(store.records).toHaveLength(0);
  });
});
