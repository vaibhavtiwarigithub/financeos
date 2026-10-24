import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const state = vi.hoisted(() => ({ reads: [] as any[], evaluations: [] as any[] }));
vi.mock("@/lib/auth/cron", () => ({ verifyCronSecret: () => true }));
vi.mock("@/lib/auth/require-owner", () => ({ requireOwner: () => null }));
vi.mock("@/lib/score-variants/core", () => ({ HORIZONS: [5, 10], VARIANT_SET: "fixed", VARIANTS: [{ id: "fixed" }],
  evaluateVariant: (def: any, rows: any[], horizon: number, market: string) => {
    state.evaluations.push({ id: def.id, rows, horizon, market });
    return { sessions: 0, avgCrossSection: 0, independentWindows: 0, variant: {}, baseline: {}, reason: "insufficient", classification: "insufficient_evidence" };
  },
}));
vi.mock("@/lib/score-variants/mining", () => ({ MINING_HORIZONS: [2, 5, 10, 20],
  asMinedVariant: (row: any) => ({ id: row.variant_id }), parseMiningRationale: (value: string) => JSON.parse(value),
}));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({ from(table: string) {
  const read: any = { table, filters: {} }; state.reads.push(read);
  const query: any = {
    select(fields: string) { read.fields = fields; return query; },
    eq(key: string, value: any) { read.filters[key] = value; return query; },
    like() { read.mined = true; return query; }, order() { return query; }, range() { return query; }, insert() { return query; },
    then(resolve: any, reject: any) {
      let data: any[] = [];
      if (table === "score_variant_registry") data = read.mined
        ? [["us", 5], ["us", 10], ["us", 20], ["india", 5]].map(([market, horizon], i) => ({ variant_set: `formula_mined_v1_${i}`, variant_id: `mined${i}`, declared_at: "2026-10-01T00:00:00Z", rationale: JSON.stringify({ market, horizonDays: horizon }) }))
        : [{ variant_id: "fixed", declared_at: "2026-10-01T00:00:00Z" }];
      if (table === "observation_labels") data = ["entry_candidate", "holding"].map((context, i) => ({
        observation_id: i + 1, benchmark_neutral_return: i / 100,
        decision_observations: { id: i + 1, symbol: `TEST${i}`, ts: "2026-10-20T12:00:00Z", analyst_score: 65,
          fundamental_score: 60, technical_score: 70, availability_mask: { fundamental: true, technical: true },
          direction: "long", decision_context: context, entry_eligible: true },
      }));
      return Promise.resolve({ data, error: null }).then(resolve, reject);
    },
  }; return query;
} }) }));
import { GET } from "@/app/api/agents/score-variants/evaluate/route";

describe("fixed/mined formula shared label reads", () => {
  it("reads each market/horizon once and preserves separate holding/entry populations", async () => {
    const response = await GET(new NextRequest("https://example.test/api/agents/score-variants/evaluate"));
    expect(response.status).toBe(200);
    const labelReads = state.reads.filter((r) => r.table === "observation_labels");
    expect(labelReads).toHaveLength(5);
    expect(labelReads.filter((r) => r.filters["decision_observations.market"] === "us" && r.filters.horizon_days === 5)).toHaveLength(1);
    const fixed = state.evaluations.filter((e) => e.id === "fixed" && e.rows.length);
    expect(fixed).toHaveLength(4);
    expect(fixed.every((e) => e.rows.map((r: any) => r.symbol).join(",") === "TEST0,TEST1")).toBe(true);
    const mined = state.evaluations.filter((e) => e.id.startsWith("mined") && e.rows.length);
    expect(mined).toHaveLength(4);
    expect(mined.every((e) => e.rows.length === 1 && e.rows[0].symbol === "TEST0")).toBe(true);
  });
});
