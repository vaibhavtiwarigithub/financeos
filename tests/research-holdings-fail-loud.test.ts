import { describe, expect, it, vi, beforeEach } from "vitest";

// Regression: fetchHoldings used to end in `catch { return []; }`. A broken
// holdings query therefore degraded SILENTLY into "the owner holds nothing" —
// research would score new BUY candidates while blind to every position it might
// need to SELL, with nothing logged and no alert. These tests pin the contract:
// a holdings-fetch failure must raise a System Health issue and THROW. It must
// never resolve to [].

const reportIssue = vi.fn().mockResolvedValue(undefined);
const resolveIssue = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/system-health", () => ({
  reportIssue: (...args: unknown[]) => reportIssue(...args),
  resolveIssue: (...args: unknown[]) => resolveIssue(...args),
}));

// research-agent pulls in the whole scoring/provider graph at import time; stub
// the edges this test never exercises so the module loads in isolation.
vi.mock("@/lib/llm-router", () => ({ callLLM: vi.fn() }));
vi.mock("@/lib/robinhood-mcp", () => ({ captureAllRobinhoodAccounts: vi.fn() }));
vi.mock("@/lib/kite", () => ({ getKiteHoldings: vi.fn() }));

const { fetchHoldings } = await import("@/lib/research-agent");

/** Minimal PostgREST-shaped stub: from().select()... resolves to {data,error}. */
function supabaseStub(handlers: Record<string, () => Promise<{ data: unknown; error: unknown }>>) {
  return {
    from(table: string) {
      const result = handlers[table] ?? (async () => ({ data: [], error: null }));
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order", "limit", "in", "not", "gte", "or"]) {
        chain[m] = () => chain;
      }
      chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        result().then(resolve, reject);
      return chain;
    },
  };
}

describe("fetchHoldings fails loud (never silently empty)", () => {
  beforeEach(() => { reportIssue.mockClear(); resolveIssue.mockClear(); });

  it("throws and alerts when the live_account_snapshots read errors", async () => {
    const supabase = supabaseStub({
      live_account_snapshots: async () => ({ data: null, error: { message: "permission denied for table live_account_snapshots" } }),
      paper_positions: async () => ({ data: [], error: null }),
    });

    await expect(fetchHoldings(supabase)).rejects.toThrow(/live_account_snapshots read failed/);

    expect(reportIssue).toHaveBeenCalledTimes(1);
    const issue = reportIssue.mock.calls[0][0] as Record<string, string>;
    expect(issue.issueKey).toBe("research-holdings-fetch:us");
    expect(issue.severity).toBe("critical");
    expect(issue.detail).toContain("permission denied");
  });

  it("throws and alerts when the paper_positions read errors", async () => {
    const supabase = supabaseStub({
      live_account_snapshots: async () => ({ data: [], error: null }),
      paper_positions: async () => ({ data: null, error: { message: "relation does not exist" } }),
    });

    await expect(fetchHoldings(supabase)).rejects.toThrow(/paper_positions \(us\) read failed/);
    expect(reportIssue).toHaveBeenCalledTimes(1);
  });

  it("throws and alerts when the client itself throws (network / bad shape)", async () => {
    const supabase = supabaseStub({
      live_account_snapshots: async () => { throw new Error("fetch failed"); },
      paper_positions: async () => ({ data: [], error: null }),
    });

    await expect(fetchHoldings(supabase)).rejects.toThrow(/fetchHoldings \(us\) failed/);
    expect(reportIssue).toHaveBeenCalledTimes(1);
    expect((reportIssue.mock.calls[0][0] as Record<string, string>).severity).toBe("critical");
  });

  it("still returns the real book on a healthy read", async () => {
    const supabase = supabaseStub({
      live_account_snapshots: async () => ({
        data: [{ broker: "robinhood", account_id: "965848641", captured_at: "2026-07-16", positions_json: [{ symbol: "AVGO", qty: 3 }, { symbol: "HOOD", qty: 1 }] }],
        error: null,
      }),
      paper_positions: async () => ({ data: [{ symbol: "msft", qty: 2 }], error: null }),
    });

    await expect(fetchHoldings(supabase)).resolves.toEqual(["AVGO", "HOOD", "MSFT"]);
    expect(reportIssue).not.toHaveBeenCalled();
  });
});
