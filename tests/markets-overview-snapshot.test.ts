import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The cadence contract for /api/markets/overview.
//
// The route serves DAILY values (close vs prior close), immutable once a session
// publishes, but used to resolve them against the provider behind a 5-minute
// route cache and a 5-minute PER-INSTANCE memory cache — up to ~288 refresh
// windows a day, multiplied by however many serverless instances are warm.
//
// Reading `price_cache` instead was tried and rejected on production evidence
// (see tests/markets-overview.test.ts, 2026-07-17): a ragged cache head makes
// its newest ALIGNED session staler than grouped and re-opens cross-session
// mixing. So the SOURCE is unchanged and only the CADENCE is fixed, by making
// the resolved result durable and shared per session.

let snapshotRow: { session_date: string; payload: unknown } | null = null;
const upserts: any[] = [];

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: () => ({ maybeSingle: async () => ({ data: snapshotRow, error: null }) }),
          }),
        }),
      }),
      upsert: async (row: any) => { upserts.push(row); return { error: null }; },
    }),
  }),
}));

const S0716 = { SPY: 750.72, QQQ: 717.0, DIA: 525.0, VIXY: 20.56, XLK: 177.52, XLF: 56.8, XLE: 57.02, XLV: 161.8, XLI: 179.3, XLY: 116.04, XLP: 83.9, XLRE: 45.46, XLU: 45.41, XLB: 50.89, XLC: 111.64 };
const S0715 = { SPY: 754.81, QQQ: 717.74, DIA: 525.95, VIXY: 20.06, XLK: 181.58, XLF: 56.56, XLE: 56.5, XLV: 158.29, XLI: 180.06, XLY: 117, XLP: 83.47, XLRE: 44.56, XLU: 45.22, XLB: 50.5, XLC: 113.38 };
const TS = 1784232000000;

const grouped = (closes: Record<string, number>) => ({
  status: "OK",
  results: Object.entries(closes).map(([T, c]) => ({ T, o: c, c, t: TS })),
});
const res = (status: number, body: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

const calls: string[] = [];
function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: any) => {
    const url = String(input);
    calls.push(url);
    const date = url.match(/market\/stocks\/(\d{4}-\d{2}-\d{2})/)?.[1];
    if (date === "2026-07-16") return res(200, grouped(S0716));
    if (date === "2026-07-15") return res(200, grouped(S0715));
    return res(200, { status: "OK", adjusted: true });
  }));
}

async function loadRoute() {
  vi.resetModules();
  return await import("@/app/api/markets/overview/route");
}

beforeEach(() => {
  vi.resetModules();
  calls.length = 0;
  upserts.length = 0;
  snapshotRow = null;
  process.env.MASSIVE_API_KEY = "test-key";
  vi.useFakeTimers();
  // 2026-07-17 00:02 ET — a trading day whose session has NOT closed, so the
  // latest session that should already be published is Thu 2026-07-16.
  vi.setSystemTime(new Date("2026-07-17T04:02:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("/api/markets/overview — once per session, not once per 5 minutes", () => {
  it("serves a current session's snapshot with ZERO provider requests", async () => {
    snapshotRow = {
      session_date: "2026-07-16",
      payload: { indices: [{ symbol: "SPY", price: 750.72 }], sectors: [], sessionDate: "2026-07-16", priorCloseDate: "2026-07-15", stale: false, unavailableCount: 0, fetchedAt: "2026-07-17T00:00:00.000Z" },
    };
    installFetch();
    const { GET } = await loadRoute();
    const body = await (await GET()).json();

    expect(calls.length).toBe(0); // the whole point
    expect(body.sessionDate).toBe("2026-07-16");
    expect(body.indices[0].price).toBe(750.72);
  });

  it("re-resolves when the stored session is older than the session that should have published", async () => {
    // Stored 07-15, but 07-16 has closed — serving the stored one would show a
    // stale session indefinitely, which is the failure mode a durable cache
    // invites and the reason it is keyed by session rather than wall-clock day.
    snapshotRow = { session_date: "2026-07-15", payload: { sessionDate: "2026-07-15" } };
    installFetch();
    const { GET } = await loadRoute();
    const body = await (await GET()).json();

    expect(calls.length).toBeGreaterThan(0);
    expect(body.sessionDate).toBe("2026-07-16");
  });

  it("stores the resolved session so the next request needs no provider", async () => {
    installFetch();
    const { GET } = await loadRoute();
    await (await GET()).json();

    expect(upserts.length).toBe(1);
    expect(upserts[0].market).toBe("us");
    expect(upserts[0].session_date).toBe("2026-07-16");
    expect(upserts[0].payload.sessionDate).toBe("2026-07-16");
  });

  // NOTE: this proves the OUTCOME (a rate-limited response is never stored), not
  // the `overview.degraded` clause specifically — degradedOverview() always sets
  // sessionDate to null, so the sessionDate guard alone already blocks it.
  // Removing the `|| overview.degraded` clause does not fail this test; it is
  // kept as redundant defence in case a future degraded path carries a session.
  it("never stores a degraded payload — a rate limit must not be frozen in for a session", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls.push("rate-limited");
      return res(429, { error: "rate limit" });
    }));
    const { GET } = await loadRoute();
    const body = await (await GET()).json();

    expect(body.degraded).toBeTruthy();
    expect(upserts.length).toBe(0);
  });

  it("falls through to the provider when the cache read fails, rather than serving nothing", async () => {
    snapshotRow = null;
    installFetch();
    const { GET } = await loadRoute();
    const body = await (await GET()).json();
    expect(body.sessionDate).toBe("2026-07-16");
    expect(body.unavailableCount).toBe(0);
  });
});
