// Router §7 outage drills.
//
// features/router-cutover/FEATURE_ARCHITECTURE.md §7 requires, before any market
// may activate: "organic cache/live/fallback/no-data cases plus forced timeout,
// quota exhaustion, schema drift, provider disagreement, and complete-primary-
// provider outage drills". None had ever been run — the release-evidence table
// recorded 0 drills for both markets while the session counters climbed.
//
// The invariant every drill shares, and the reason the section exists at all:
// a broken provider must produce a TYPED UNAVAILABLE, never a fabricated or
// silently-substituted value. §2.4 states no missing/stale/conflicting/quarantined
// evidence is converted to zero or neutral; §5 states provider/routing change alone
// cannot create a newly eligible long. A fault that leaked a plausible-looking
// payload would defeat both at once, because the scorer downstream cannot tell a
// real 0.12 from an invented one.
//
// These drive the real resolver. Only the adapter registry and the Supabase client
// are mocked, so the policy gate, lease path, validation, cache-write and chain
// fallback under test are production code.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FieldProvenance, ProviderAdapter } from "@/lib/evidence/contracts";

const state = vi.hoisted(() => ({
  routerEnabled: true,          // drills exercise the post-cutover path
  rpcAcquired: true,
  adapters: [] as ProviderAdapter[],
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
  adaptersForIntent: () => state.adapters,
  PROVIDER_SPECS: {
    finnhub:  { minIntervalMs: 1_000, freshTtlSeconds: 3600, staleCeilingSeconds: 7200 },
    yahoo:    { minIntervalMs: 0,     freshTtlSeconds: 3600, staleCeilingSeconds: 7200 },
    massive:  { minIntervalMs: 12_500, freshTtlSeconds: 3600, staleCeilingSeconds: 7200 },
  },
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      if (table === "active_evidence_policy") return query({ data: { policy_version_id: "policy-1" }, error: null });
      if (table === "evidence_policy_versions") return query({ data: { router_enabled: state.routerEnabled }, error: null });
      if (table === "evidence_policy_rules") return query({
        data: {
          mode: "auto", preferred_provider: null, policy_version_id: "policy-1",
          max_age_seconds: 86_400, stale_max_seconds: 172_800, max_sync_attempts: 2,
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

const prov = (providerId: any): FieldProvenance[] => ([{
  providerId,
  providerField: "metric",
  basis: "ttm",
  retrievedAt: "2026-08-10T00:00:00.000Z",
  currency: "USD",
  unit: "ratio",
}]);

/** A healthy adapter that returns a real canonical value. */
function goodAdapter(providerId: any, value: number): ProviderAdapter {
  return {
    providerId,
    intent: "fundamentals.reported",
    contractVersion: "drill-v1",
    fetch: vi.fn(async () => ({ ok: true, payload: { raw: value } })),
    validate: vi.fn((raw: any) => ({ ok: true, payload: raw })),
    toCanonical: vi.fn((v: any) => ({ payload: { revenueGrowth: v.payload.raw }, provenance: prov(providerId) })),
  } as unknown as ProviderAdapter;
}

const REQ = { market: "us", symbol: "AAPL", intent: "fundamentals.reported" } as const;

beforeEach(() => {
  state.routerEnabled = true;
  state.rpcAcquired = true;
  state.cache = null;
  state.upserts = [];
  state.inserts = [];
  state.adapters = [];
});

// ── Drill 1: forced timeout ──────────────────────────────────────────────────
describe("§7 drill — forced timeout", () => {
  it("reports typed unavailable and fabricates nothing when the only provider times out", async () => {
    state.adapters = [{
      ...goodAdapter("finnhub", 0.12),
      fetch: vi.fn(async () => ({ ok: false, unavailableReason: "timeout" })),
    } as unknown as ProviderAdapter];

    const env = await resolveEvidence({ ...REQ });

    expect(env.quality).toBe("unavailable");
    expect(env.payload).toBeNull();
    expect(env.unavailableReason).toBe("timeout");
    // A timeout must never leave a cache row — a later resolve would serve the
    // invented value as though a provider had returned it.
    expect(state.upserts).toHaveLength(0);
  });

  it("survives an adapter that throws rather than returning a result", async () => {
    state.adapters = [{
      ...goodAdapter("finnhub", 0.12),
      fetch: vi.fn(async () => { throw new Error("socket hang up"); }),
    } as unknown as ProviderAdapter];

    const env = await resolveEvidence({ ...REQ });

    expect(env.quality).toBe("unavailable");
    expect(env.payload).toBeNull();
    expect(env.unavailableReason).toBe("provider_error");
  });
});

// ── Drill 2: quota exhaustion ────────────────────────────────────────────────
describe("§7 drill — quota exhaustion", () => {
  it("returns rate_limited without calling the provider when the lease is denied", async () => {
    const adapter = goodAdapter("finnhub", 0.12);
    state.adapters = [adapter];
    state.rpcAcquired = false; // pacing/budget refuses the slot

    const env = await resolveEvidence({ ...REQ });

    expect(env.quality).toBe("unavailable");
    expect(env.payload).toBeNull();
    expect(env.unavailableReason).toBe("rate_limited");
    // The point of a lease denial is that the call does NOT happen.
    expect(adapter.fetch).not.toHaveBeenCalled();
    // and the work is queued for later rather than dropped, so a quota denial
    // defers the fetch instead of silently losing the field for the day
    expect(state.inserts.some(i => i.table === "provider_refresh_jobs")).toBe(true);
  });
});

// ── Drill 3: schema drift ────────────────────────────────────────────────────
describe("§7 drill — schema drift", () => {
  it("rejects a payload whose shape changed and does not cache it", async () => {
    state.adapters = [{
      ...goodAdapter("finnhub", 0.12),
      // Provider answered 200 OK, but the body no longer matches the contract.
      fetch: vi.fn(async () => ({ ok: true, payload: { unexpected: "shape" } })),
      validate: vi.fn(() => ({ ok: false, unavailableReason: "schema_invalid" })),
    } as unknown as ProviderAdapter];

    const env = await resolveEvidence({ ...REQ });

    expect(env.quality).toBe("unavailable");
    expect(env.payload).toBeNull();
    expect(env.unavailableReason).toBe("schema_invalid");
    // Caching an unvalidated payload would turn one bad deploy into days of
    // poisoned evidence served as "fresh".
    expect(state.upserts).toHaveLength(0);
  });

  it("falls through to a healthy provider when the primary's schema drifts", async () => {
    const healthy = goodAdapter("yahoo", 0.34);
    state.adapters = [
      {
        ...goodAdapter("finnhub", 0.12),
        validate: vi.fn(() => ({ ok: false, unavailableReason: "schema_invalid" })),
      } as unknown as ProviderAdapter,
      healthy,
    ];

    const env = await resolveEvidence({ ...REQ });

    expect(env.quality).toBe("fresh");
    expect(env.payload).toEqual({ revenueGrowth: 0.34 });
    // Provenance must name the provider that actually served it, not the one
    // the chain nominally leads with.
    expect(env.provenance[0]?.providerId).toBe("yahoo");
    expect(env.providersAttempted).toEqual(["finnhub", "yahoo"]);
  });
});

// ── Drill 4: provider disagreement ───────────────────────────────────────────
describe("§7 drill — provider disagreement", () => {
  it("serves exactly one provider's value and records which, never a blend", async () => {
    // Two healthy providers that disagree on the same field.
    state.adapters = [goodAdapter("finnhub", 0.12), goodAdapter("yahoo", 0.99)];

    const env = await resolveEvidence({ ...REQ });

    // The chain is ordered, so the first healthy provider wins outright.
    expect(env.payload).toEqual({ revenueGrowth: 0.12 });
    expect(env.provenance[0]?.providerId).toBe("finnhub");
    // Averaging or merging disagreeing sources would invent a number no provider
    // reported and destroy the audit trail §2.3 requires.
    expect(env.payload).not.toEqual({ revenueGrowth: 0.555 });
    // Short-circuiting on the first success also means the second provider is
    // never spent — disagreement costs no extra quota.
    expect(env.providersAttempted).toEqual(["finnhub"]);
  });
});

// ── Drill 5: complete primary-provider outage ────────────────────────────────
describe("§7 drill — complete primary-provider outage", () => {
  it("exhausts the chain and abstains rather than inventing a value", async () => {
    const dead = (id: any) => ({
      ...goodAdapter(id, 0),
      fetch: vi.fn(async () => ({ ok: false, unavailableReason: "provider_error" })),
    } as unknown as ProviderAdapter);
    state.adapters = [dead("finnhub"), dead("yahoo")];

    const env = await resolveEvidence({ ...REQ });

    expect(env.quality).toBe("unavailable");
    expect(env.payload).toBeNull();
    expect(env.unavailableReason).toBe("provider_error");
    expect(state.upserts).toHaveLength(0);
  });

  it("stops at MAX_SYNC_ATTEMPTS instead of walking an unbounded chain", async () => {
    // The Vercel wall-clock bound is 2 synchronous attempts; a 4-provider chain
    // must not turn one resolve into four sequential provider timeouts.
    const dead = (id: any) => ({
      ...goodAdapter(id, 0),
      fetch: vi.fn(async () => ({ ok: false, unavailableReason: "timeout" })),
    } as unknown as ProviderAdapter);
    state.adapters = [dead("finnhub"), dead("yahoo"), dead("massive")];

    const env = await resolveEvidence({ ...REQ });

    expect(env.quality).toBe("unavailable");
    expect(env.providersAttempted.length).toBeLessThanOrEqual(2);
  });
});

// ── Cross-cutting invariant ──────────────────────────────────────────────────
describe("§7 drills — shared invariant", () => {
  it("never returns a non-null payload on any fault class", async () => {
    const faults: Array<[string, Partial<ProviderAdapter>]> = [
      ["timeout",        { fetch: vi.fn(async () => ({ ok: false, unavailableReason: "timeout" })) } as any],
      ["provider_error", { fetch: vi.fn(async () => { throw new Error("down"); }) } as any],
      ["schema_invalid", { validate: vi.fn(() => ({ ok: false, unavailableReason: "schema_invalid" })) } as any],
      ["genuine_no_data",{ fetch: vi.fn(async () => ({ ok: false, unavailableReason: "genuine_no_data" })) } as any],
    ];

    for (const [label, override] of faults) {
      state.upserts = [];
      state.adapters = [{ ...goodAdapter("finnhub", 0.12), ...override } as unknown as ProviderAdapter];
      const env = await resolveEvidence({ ...REQ });
      expect(env.payload, `${label} must not produce a payload`).toBeNull();
      expect(env.quality, `${label} must be unavailable`).toBe("unavailable");
      expect(state.upserts, `${label} must not write cache`).toHaveLength(0);
    }
  });
});
