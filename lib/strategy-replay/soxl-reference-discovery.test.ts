import { describe, expect, it } from "vitest";
import { runSoxlReferenceDiagnostic } from "./reference-discovery";

function service(rows: Record<string, any[]>) {
  const calls: string[] = [];
  let trialIndex = 0;
  return {
    calls,
    client: {
      rpc: async (name: string) => {
        calls.push(`rpc:${name}`); trialIndex++;
        return { data: [{ trial_index: trialIndex, trials_considered: trialIndex, was_new: true }], error: null };
      },
      from: (table: string) => {
        let symbol = "";
        const query: any = {
          select: () => query,
          eq: (_field: string, value: string) => { symbol = value; return query; },
          lte: () => query,
          order: () => query,
          limit: () => { calls.push(`read:${table}:${symbol}`); return Promise.resolve({ data: rows[symbol] ?? [], error: null }); },
        };
        return query;
      },
    },
  };
}

describe("natural SOXL reference discovery", () => {
  it("registers the fixed baseline and all VIX variants before reading cached bars", async () => {
    const mock = service({});
    const result = await runSoxlReferenceDiagnostic(mock.client, "2026-11-08");
    expect(mock.calls.slice(0, 8)).toEqual(Array(8).fill("rpc:register_trial"));
    expect(mock.calls.slice(8, 11)).toEqual(["read:price_cache:SOXX", "read:price_cache:SOXL", "read:price_cache:VIX"]);
    expect(result.status).toBe("insufficient_data");
    expect((result as any).summary).toBeNull();
  });

  it("persists no claim when cache provenance is absent", async () => {
    const mock = service({ SOXX: [{ date: "2026-11-06", open: 1, high: 1, low: 1, close: 1, provider: null, price_basis: null, provenance_version: null }] });
    const result = await runSoxlReferenceDiagnostic(mock.client, "2026-11-08");
    expect(result.status).toBe("insufficient_data");
    expect((result as any).summary).toBeNull();
  });
});
