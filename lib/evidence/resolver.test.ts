import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FieldProvenance, ProviderAdapter } from "@/lib/evidence/contracts";

const state = vi.hoisted(() => ({
  routerEnabled: false,
  rpcAcquired: true,
  adapter: null as ProviderAdapter | null,
  cache: null as Record<string, unknown> | null,
  upserts: [] as Record<string, unknown>[],
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
}));

function query(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "order", "limit"]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.maybeSingle = vi.fn(async () => result);
  chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return chain;
}

vi.mock("@/lib/evidence/registry", () => ({
  adaptersForIntent: () => state.adapter ? [state.adapter] : [],
  PROVIDER_SPECS: { finnhub: { minIntervalMs: 1_000 } },
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      if (table === "active_evidence_policy") return query({ data: { policy_version_id: "policy-1" }, error: null });
      if (table === "evidence_policy_versions") return query({ data: { router_enabled: state.routerEnabled }, error: null });
      if (table === "evidence_policy_rules") return query({
        data: {
          mode: "auto",
          preferred_provider: null,
          policy_version_id: "policy-1",
          max_age_seconds: 86_400,
          stale_max_seconds: 172_800,
          max_sync_attempts: 2,
        },
        error: null,
      });
      if (table === "provider_runtime_config") return query({ data: [], error: null });
      if (table === "evidence_cache_v2") {
        const cacheQuery = query({ data: state.cache, error: null });
        (cacheQuery as any).upsert = vi.fn(async (row: Record<string, unknown>) => {
          state.upserts.push(row);
          return { error: null };
        });
        return cacheQuery;
      }
      return {
        insert: vi.fn(async (row: Record<string, unknown>) => {
          state.inserts.push({ table, row });
          return { error: null };
        }),
      };
    },
    rpc: vi.fn(async () => ({ data: state.rpcAcquired, error: null })),
  }),
}));

import { resolveEvidence } from "@/lib/evidence/resolver";

const provenance: FieldProvenance[] = [{
  providerId: "finnhub",
  providerField: "metric",
  basis: "ttm",
  retrievedAt: "2026-07-15T00:00:00.000Z",
  currency: "USD",
  unit: "ratio",
}];

describe("resolveEvidence safety gates", () => {
  beforeEach(() => {
    state.routerEnabled = false;
    state.rpcAcquired = true;
    state.cache = null;
    state.upserts = [];
    state.inserts = [];
    state.adapter = {
      providerId: "finnhub",
      intent: "fundamentals.reported",
      contractVersion: "test-v1",
      fetch: vi.fn(async () => ({ ok: true, payload: { raw: true } })),
      validate: vi.fn((raw) => ({ ok: true, payload: raw })),
      toCanonical: vi.fn(() => ({ payload: { revenueGrowth: 0.12 }, provenance })),
    };
  });

  it("blocks ordinary callers while the active policy is shadow-only", async () => {
    const result = await resolveEvidence({ market: "us", symbol: "AAPL", intent: "fundamentals.reported" });

    expect(result.unavailableReason).toBe("disabled_by_policy");
    expect(state.adapter?.fetch).not.toHaveBeenCalled();
  });

  it("allows the explicit shadow caller and retains provenance in cache and response", async () => {
    const result = await resolveEvidence({
      market: "us",
      symbol: "AAPL",
      intent: "fundamentals.reported",
      allowDisabledPolicy: true,
    });

    expect(result.quality).toBe("fresh");
    expect(result.provenance).toEqual(provenance);
    expect(state.upserts[0]?.provenance).toEqual(provenance);
  });

  it("does not call a provider when the durable pacing lease is denied", async () => {
    state.rpcAcquired = false;

    const result = await resolveEvidence({
      market: "us",
      symbol: "AAPL",
      intent: "fundamentals.reported",
      allowDisabledPolicy: true,
    });

    expect(result.unavailableReason).toBe("rate_limited");
    expect(state.adapter?.fetch).not.toHaveBeenCalled();
    expect(state.inserts.some(({ table }) => table === "provider_refresh_jobs")).toBe(true);
  });

  it("returns cached provenance without acquiring a lease", async () => {
    state.cache = {
      payload: { revenueGrowth: 0.12 },
      provenance,
      expires_at: "2099-01-01T00:00:00.000Z",
      stale_until: "2099-01-02T00:00:00.000Z",
      quality_state: "fresh",
    };

    const result = await resolveEvidence({
      market: "us",
      symbol: "AAPL",
      intent: "fundamentals.reported",
      allowDisabledPolicy: true,
    });

    expect(result.cacheState).toBe("fresh");
    expect(result.provenance).toEqual(provenance);
    expect(state.adapter?.fetch).not.toHaveBeenCalled();
  });

  it("treats a cache-only miss as readiness evidence and performs no provider work", async () => {
    const result = await resolveEvidence({
      market: "us",
      symbol: "AAPL",
      intent: "fundamentals.reported",
      allowDisabledPolicy: true,
      cacheOnly: true,
      runId: "cohort:test",
    });

    expect(result.quality).toBe("unavailable");
    expect(result.providersAttempted).toEqual([]);
    expect(state.adapter?.fetch).not.toHaveBeenCalled();
    expect(state.upserts).toEqual([]);
    expect(state.inserts.some(({ table }) => table === "provider_refresh_jobs")).toBe(false);
  });

  it("does not spend a live-attempt slot on a cache-read-only adapter", async () => {
    state.adapter = { ...state.adapter!, cacheReadOnly: true };

    const result = await resolveEvidence({
      market: "us",
      symbol: "AAPL",
      intent: "fundamentals.reported",
      allowDisabledPolicy: true,
    });

    expect(result.quality).toBe("unavailable");
    expect(result.providersAttempted).toEqual([]);
    expect(state.adapter.fetch).not.toHaveBeenCalled();
  });
});
