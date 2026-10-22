import { beforeEach, describe, expect, it, vi } from "vitest";
import { guardianSessions } from "@/lib/live-recommendations/guardian-stop";
const mocks = vi.hoisted(() => ({ pages: vi.fn(), raw: vi.fn() }));
vi.mock("@/lib/supabase/paginate", () => ({ fetchAllRows: mocks.pages }));
vi.mock("@/lib/data/yahoo-candles", () => ({ fetchYahooRawReplaySeries: mocks.raw }));
import { collectGuardianOutcomeMarks, loadGuardianOutcomeScorecard } from "@/lib/live-recommendations/guardian-store";

const stamp = "2026-10-01T15:00:00Z";
const rec = { id: 1, market: "us", account_id: "TEST", symbol: "TEST-NO-REAL-ASSET", issued_at: stamp,
  level_price: "95", qty_suggested: "10", source_table: "agentic_position_ledger", source_id: "1",
  guardian_contract: { version: "guardian_exact_stop_v1", reference_basis: "next_session_open", captured_at: stamp,
    episode_key: "ledger:1", source_version: "test", extra_sell_cost_bps: 10 } };
const series = () => ({ candles: guardianSessions("us", stamp, 20)!.map(date => ({ date, open: 100, high: 101, low: 99, close: 100 })), corporateActions: [] });
function setup(prior: any[] = [], writeError = false, actions: any[] = []) {
  let read = 0;
  mocks.pages.mockImplementation(async (_query, label) => label === "frozen Guardian suggestions" ? (++read === 1 ? [rec] : [])
    : label === "Guardian frozen matured marks" || label === "persisted Guardian outcomes" ? prior
    : label === "Guardian known corporate actions" ? actions : []);
  const write = vi.fn().mockResolvedValue({ error: writeError ? { message: "fixture write failed" } : null });
  return { svc: { from: vi.fn((_table: string) => ({ upsert: write })) }, write };
}
beforeEach(() => { vi.resetAllMocks(); mocks.raw.mockResolvedValue(series()); });
describe("scheduled Guardian outcome persistence", () => {
  it("writes all four horizons and reports both markets without making broker calls", async () => {
    const { svc, write } = setup();
    const result = await collectGuardianOutcomeMarks(svc, new Date("2026-11-10T23:00:00Z"));
    expect(result.us.ready).toBe(4); expect(result.india.suggestions).toBe(0);
    const mark = write.mock.calls[0][0][0];
    expect(mark.guardian_outcomes.outcomes.map((o: any) => o.horizon)).toEqual([2, 5, 10, 20]);
    expect(mark.guardian_outcomes.response.state).toBe("unknown");
    expect(write.mock.calls[0][1]).toEqual({ onConflict: "rec_id,marked_on", ignoreDuplicates: true });
    expect(svc.from.mock.calls.every(([table]) => table === "live_recommendation_marks")).toBe(true);
  });
  it.each(["ready", "excluded_corporate_action"])("preserves the first matured %s result even when a later source changes", async state => {
    const frozen = [2, 5, 10, 20].map(horizon => ({ horizon, state, reason: "frozen fixture", netDeltaPct: state === "ready" ? 7 : undefined, priceWindow: [{ close: 123 }] }));
    const { svc, write } = setup([{ rec_id: 1, guardian_outcomes: { version: "guardian_exact_stop_v1", outcomes: frozen } }]);
    await collectGuardianOutcomeMarks(svc, new Date("2026-11-11T23:00:00Z"));
    expect(mocks.raw).not.toHaveBeenCalled();
    expect(write.mock.calls[0][0][0].guardian_outcomes.outcomes[0].priceWindow).toEqual([{ close: 123 }]);
  });
  it("surfaces failed sources and missing matured bars rather than inventing zero returns", async () => {
    mocks.raw.mockRejectedValue(new Error("synthetic source unavailable"));
    const { svc, write } = setup();
    const result = await collectGuardianOutcomeMarks(svc, new Date("2026-11-10T23:00:00Z"));
    expect(result.us.failed).toBe(1); expect(result.us.unavailable).toBe(4); expect(result.us.ready).toBe(0);
    expect(write.mock.calls[0][0][0].guardian_outcomes.outcomes.every((o: any) => o.state === "missing_data" && o.netDeltaPct == null)).toBe(true);
  });
  it("does not swallow append persistence errors", async () => {
    const { svc } = setup([], true);
    await expect(collectGuardianOutcomeMarks(svc)).rejects.toThrow("outcome write failed");
  });
  it("excludes local corporate-action evidence even if the price provider omitted the event", async () => {
    const { svc } = setup([], false, [{ symbol: rec.symbol, ex_date: "2026-10-02", effective_date: null }]);
    const result = await collectGuardianOutcomeMarks(svc, new Date("2026-11-10T23:00:00Z"));
    expect(result.us.ready).toBe(0); expect(result.us.unavailable).toBe(0);
  });
  it("does not spend a price fetch before any horizon has matured", async () => {
    const { svc, write } = setup();
    const result = await collectGuardianOutcomeMarks(svc, new Date("2026-10-01T16:00:00Z"));
    expect(mocks.raw).not.toHaveBeenCalled(); expect(result.us.unavailable).toBe(0);
    expect(write.mock.calls[0][0][0].guardian_outcomes.outcomes.every((o: any) => o.state === "immature")).toBe(true);
  });
  it("renders an ungraded record with null performance before any successful producer", async () => {
    const { svc } = setup();
    const result = await loadGuardianOutcomeScorecard(svc, "us");
    expect(result.evaluatedAt).toBeNull(); expect(result.summary.every(s => s.evaluated === 0 && s.meanDeltaPct === null)).toBe(true);
  });
});
