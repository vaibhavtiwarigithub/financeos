import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { candidateExpirySession, canRetainCandidate, recordRecentCandidate, recentCandidatesForResearch } from "@/lib/research/recent-candidates";
import { refreshRecentCandidatesForCapacity } from "@/lib/research/refresh-recent-candidates";
import { latestQualifiedEntrySignals } from "@/lib/trading/fresh-entry-signals";

vi.mock("@/lib/system-health", () => ({ reportIssue: vi.fn().mockResolvedValue(undefined), resolveIssue: vi.fn().mockResolvedValue(undefined) }));
import { reportIssue, resolveIssue } from "@/lib/system-health";

const now = new Date("2026-10-21T15:00:00Z");
const row = (symbol = "AMD", latest_session = "2026-10-19", score = 75) => ({ id: symbol, symbol, market: "us" as const,
  first_signal_id: "first", latest_signal_id: "latest", first_score: 80, latest_score: score,
  first_session: "2026-10-19", latest_session, expires_session: "2026-10-23", latest_at: "2026-10-19T14:00:00Z",
  discovery_source: "screener_momentum", state: "active" as const, refresh_lease_until: null });

describe("recent qualified candidate calendar and scope", () => {
  it("counts admission plus four US sessions, excluding weekend and holiday", () => {
    expect(candidateExpirySession("us", "2026-09-04")).toBe("2026-09-11");
    expect(candidateExpirySession("us", "2026-10-19")).toBe("2026-10-23");
  });
  it("uses the India calendar, including the October 20 holiday", () => {
    expect(candidateExpirySession("india", "2026-10-16")).toBe("2026-10-23");
  });
  it("fails closed on unsupported years, special sessions and malformed sessions", () => {
    for (const date of ["2026-12-31", "2027-01-04", "2026-02-30", "bad", "2026-10-18"]) {
      expect(() => candidateExpirySession("us", date)).toThrow();
    }
    expect(() => candidateExpirySession("india", "2026-11-08")).toThrow();
  });
  it("never retains leveraged or crypto as ordinary multi-day candidates", () => {
    for (const symbol of ["SOXL", "SOXS", "TQQQ", "SQQQ", "UPRO", "SH", "BTC-USD"]) expect(canRetainCandidate(symbol, undefined)).toBe(false);
    expect(canRetainCandidate("BTC", "crypto")).toBe(false);
    for (const symbol of ["AMD", "QTUM", "ITBEES.NS"]) expect(canRetainCandidate(symbol, "etf")).toBe(true);
  });
});

describe("candidate persistence and bounded refresh", () => {
  beforeEach(() => vi.clearAllMocks());
  it("records the current assessment using original discovery provenance, including downgrades", async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    await recordRecentCandidate({ rpc }, { signalId: "new", symbol: "AMD", market: "us", eligible: false, source: "screener_momentum", now });
    expect(rpc).toHaveBeenCalledWith("record_recent_qualified_candidate", { p_signal_id: "new", p_eligible: false,
      p_session: "2026-10-21", p_expiry: "2026-10-27", p_source: "screener_momentum" });
  });
  it("does not create execution eligibility or silently hide a writer failure", async () => {
    await recordRecentCandidate({ rpc: vi.fn().mockResolvedValue({ error: { message: "RPC unavailable" } }) },
      { signalId: "new", symbol: "AMD", market: "us", eligible: true, source: "manual", now });
    expect(reportIssue).toHaveBeenCalledWith(expect.objectContaining({ issueKey: "recent-candidates:us:writer" }), expect.anything());
  });
  it("does not admit closed-day research", async () => {
    const rpc = vi.fn();
    await recordRecentCandidate({ rpc }, { signalId: "new", symbol: "AMD", market: "us", eligible: true,
      source: "manual", now: new Date("2026-10-18T15:00:00Z") });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("refreshes stale candidates oldest first, not historical peak score, with a five-name bound", async () => {
    const rows = [row("NEW", "2026-10-21", 99), ...Array.from({ length: 7 }, (_, i) => row(`N${i}`, "2026-10-19", 70 + i))];
    const q: any = {}; for (const method of ["select", "eq", "gte", "order"]) q[method] = vi.fn(() => q);
    q.limit = vi.fn().mockResolvedValue({ data: rows, error: null });
    const selected = await recentCandidatesForResearch({ from: vi.fn(() => q) }, "us", now);
    expect(selected.map(item => item.symbol)).toEqual(["N6", "N5", "N4", "N3", "N2"]);
  });
  it("does no inference with no room or a closed market", async () => {
    const rpc = vi.fn(), refresh = vi.fn();
    await refreshRecentCandidatesForCapacity({ rpc }, "us", { hasCapacity: false, heldSymbols: [], refresh, now });
    await refreshRecentCandidatesForCapacity({ rpc }, "india", { hasCapacity: true, heldSymbols: [], refresh, now });
    expect(rpc).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
  });
  it("claims one market-local leased batch and uses the existing fresh research writer", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [row()], error: null }); const refresh = vi.fn().mockResolvedValue({});
    expect(await refreshRecentCandidatesForCapacity({ rpc }, "us", { hasCapacity: true, heldSymbols: ["NVDA"], now, refresh }))
      .toEqual({ refreshed: 1, failed: 0 });
    expect(rpc).toHaveBeenCalledWith("claim_recent_candidate_refresh", { p_market: "us", p_session: "2026-10-21", p_excluded: ["NVDA"] });
    expect(refresh).toHaveBeenCalledWith(row()); expect(resolveIssue).toHaveBeenCalled();
  });
  it("leaves failed work untradeable and reports it without throwing away other candidates", async () => {
    const svc = { rpc: vi.fn().mockResolvedValue({ data: [row("AMD"), row("MELI")], error: null }) };
    const refresh = vi.fn().mockRejectedValueOnce(new Error("provider secret must not be logged")).mockResolvedValueOnce({});
    expect(await refreshRecentCandidatesForCapacity(svc, "us", { hasCapacity: true, heldSymbols: [], now, refresh }))
      .toEqual({ refreshed: 1, failed: 1 });
    expect(reportIssue).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.stringContaining("AMD") }), svc);
    expect(JSON.stringify(vi.mocked(reportIssue).mock.calls)).not.toContain("provider secret");
  });
  it("defers isolated refresh to batch research when relative rank gating is active", async () => {
    const q: any = {}; for (const method of ["select", "eq"]) q[method] = vi.fn(() => q);
    q.order = vi.fn().mockResolvedValue({ data: [{ market: "us", genome: { entry: { rank_pct_min: 0.7 } } }], error: null });
    const rpc = vi.fn();
    expect(await refreshRecentCandidatesForCapacity({ from: vi.fn(() => q), rpc }, "us", { hasCapacity: true, heldSymbols: [], now }))
      .toEqual({ refreshed: 0, failed: 0 });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("does not assume the rank gate is off when its policy cannot be read", async () => {
    const q: any = {}; for (const method of ["select", "eq"]) q[method] = vi.fn(() => q);
    q.order = vi.fn().mockResolvedValue({ data: null, error: { message: "read failed" } });
    const rpc = vi.fn();
    expect(await refreshRecentCandidatesForCapacity({ from: vi.fn(() => q), rpc }, "us", { hasCapacity: true, heldSymbols: [], now }))
      .toEqual({ refreshed: 0, failed: 1 });
    expect(rpc).not.toHaveBeenCalled(); expect(reportIssue).toHaveBeenCalled();
  });
});

describe("shortlist wiring and authorization contracts", () => {
  const read = (path: string) => readFileSync(path, "utf8");
  it("keeps signal expiry, levered priority and normal entry controls", () => {
    const paper = read("app/api/agents/paper-trade/route.ts");
    expect(paper.indexOf("refreshRecentCandidatesForCapacity(supabase")).toBeLessThan(paper.indexOf('let expiredTotal'));
    expect(paper).toContain('.gte("analyst_score", entryThreshold).gte("created_at", cutoff)');
    const live = read("lib/trading/autonomous-live.ts");
    expect(live.indexOf('if (!cfg.live_auto_enabled)')).toBeLessThan(live.indexOf('refreshRecentCandidatesForCapacity(svc'));
    const research = read("lib/research-agent.ts");
    expect(research.indexOf('for (const sym of LEVERAGED_SLEEVE_SYMBOLS)')).toBeLessThan(research.indexOf('const recentUs'));
    expect(research).toContain('const recentIndia = await recentCandidatesForResearch');
  });
  it("shares one display on both live markets and paper, owner gated with no side effects", () => {
    const api = read("app/api/portfolio/recent-candidates/route.ts");
    expect(api.indexOf('await requireOwner()')).toBeLessThan(api.indexOf('createServiceClient();'));
    expect(api).not.toContain('export async function POST');
    for (const file of ["PortfolioPage", "LivePortfolioPage", "IndiaLivePanel"]) expect(read(`components/dashboard/${file}.tsx`)).toContain('<RecentCandidatesPanel');
    expect(read("components/dashboard/RecentCandidatesPanel.tsx")).toContain('/dashboard/symbol/${encodeURIComponent(row.symbol)}');
  });
  it("RPCs serialize cap/lease writes, preserve expiry, and are not public", () => {
    const sql = read("supabase/migrations/20261022030420_recent_qualified_candidates.sql");
    expect(sql).toContain("pg_advisory_xact_lock"); expect(sql).toContain("refresh_attempts<2");
    expect(sql).toContain("security invoker set search_path=pg_catalog,public");
    expect(sql).toContain("from public,anon,authenticated");
    expect(sql).not.toMatch(/set\s+expires_session\s*=/i);
    expect(sql).toContain("previous.state <> 'invalidated'");
  });
});

describe("fresh live selection cannot resurrect an old higher score", () => {
  const signal = (id: string, score: number, direction = "long", status = "candidate") => ({ id, symbol: "AMD", market: "us",
    analyst_score: score, direction, created_at: `2026-10-21T${id === "old" ? "14" : "15"}:00:00Z`,
    signal_breakdown: { trade_plan: { status } } });
  it("keeps a later lower but qualifying score instead of the old maximum", () => {
    expect(latestQualifiedEntrySignals([signal("old", 99), signal("new", 72)], "us", 60).map(row => row.analyst_score)).toEqual([72]);
  });
  it("a newer downgrade, neutral, or no-entry plan defeats the old eligible long", () => {
    for (const newest of [signal("new", 40), signal("new", 90, "neutral"), signal("new", 90, "long", "no_entry")]) {
      expect(latestQualifiedEntrySignals([signal("old", 99), newest], "us", 60)).toEqual([]);
    }
  });
  it("does not mix markets or treat absent plan evidence as eligible", () => {
    expect(latestQualifiedEntrySignals([signal("old", 99)], "india", 60)).toEqual([]);
    expect(latestQualifiedEntrySignals([{ ...signal("new", 99), signal_breakdown: null }], "us", 60)).toEqual([]);
    expect(latestQualifiedEntrySignals([{ ...signal("new", 99), rank_rejected: true }], "us", 60)).toEqual([]);
  });
});
