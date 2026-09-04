import { describe, expect, it } from "vitest";
import { LABEL_ID_BATCH_SIZE, loadLabeledDataset } from "./dataset";

type Row = Record<string, unknown>;

function query(result: (range?: [number, number]) => { data: Row[] | null; error: { message: string } | null }) {
  let requestedRange: [number, number] | undefined;
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    range: (from: number, to: number) => { requestedRange = [from, to]; return chain; },
    in: (_column: string, ids: number[]) => Promise.resolve(resultForIds(ids)),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(result(requestedRange)).then(resolve),
  };
  let resultForIds = (_ids: number[]) => result();
  chain.withIn = (fn: typeof resultForIds) => { resultForIds = fn; return chain; };
  return chain;
}

function observation(id: number): Row {
  return {
    id,
    ts: `2026-01-${String((id % 28) + 1).padStart(2, "0")}T14:30:00Z`,
    market: "us",
    symbol: `S${id}`,
    analyst_score: 60,
    fundamental_score: 60,
    technical_score: 60,
    sentiment_score: 60,
    macro_score: 60,
    insider_score: 60,
    direction: "long",
    entry_eligible: true,
    score_threshold: 60,
    availability_mask: {},
  };
}

describe("loadLabeledDataset", () => {
  it("batches label ids instead of building one unbounded PostgREST filter", async () => {
    const observations = Array.from({ length: LABEL_ID_BATCH_SIZE * 2 + 1 }, (_, i) => observation(i + 1));
    const batches: number[][] = [];
    const supabase = {
      from(table: string) {
        if (table === "decision_observations") {
          return query((range) => {
            const [from, to] = range ?? [0, observations.length - 1];
            const data = observations.slice(from, to + 1);
            return { data, error: null };
          });
        }
        return query(() => ({ data: [], error: null })).withIn((ids: number[]) => {
          batches.push(ids);
          return {
            data: ids.map(id => ({ observation_id: id, horizon_days: 10, fwd_return: 0.01, benchmark_return: 0, benchmark_neutral_return: 0.01, max_adverse_excursion: -0.01, max_favorable_excursion: 0.02 })),
            error: null,
          };
        });
      },
    };

    const rows = await loadLabeledDataset(supabase, "us", 10);

    expect(rows).toHaveLength(observations.length);
    expect(batches.map(batch => batch.length)).toEqual([500, 500, 1]);
  });

  it("propagates a label batch failure instead of reporting an empty cohort", async () => {
    const supabase = {
      from(table: string) {
        if (table === "decision_observations") return query(() => ({ data: [observation(1)], error: null }));
        return query(() => ({ data: [], error: null })).withIn(() => ({ data: null, error: { message: "request too large" } }));
      },
    };

    await expect(loadLabeledDataset(supabase, "us", 10)).rejects.toThrow("observation_labels batch 1 failed: request too large");
  });
});
