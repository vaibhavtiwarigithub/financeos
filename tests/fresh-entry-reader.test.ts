import { describe, expect, it, vi } from "vitest";
import { loadFreshEntrySignals } from "@/lib/trading/fresh-entry-signals";

function svc(rows: any[], cutoff: unknown = "2026-10-21T04:00:00Z") {
  const q: any = {};
  for (const method of ["select", "eq", "gte", "order"]) q[method] = vi.fn(() => q);
  q.range = vi.fn().mockResolvedValue({ data: rows, error: null });
  return { rpc: vi.fn().mockResolvedValue({ data: cutoff, error: null }), from: vi.fn(() => q), q };
}
const row = (id: string, market: string, score: number, direction = "long", status = "pending") => ({
  id, symbol: market === "india" ? "ABC.NS" : "ABC", market, analyst_score: score, direction, status,
  created_at: `2026-10-21T${id === "old" ? "10" : "11"}:00:00Z`, signal_breakdown: { trade_plan: { status: "candidate" } },
});

describe("shared current-session entry reader", () => {
  it.each(["us", "india"] as const)("observes downgrades and neutral assessments before buy filters in %s", async market => {
    for (const next of [row("new", market, 40), row("new", market, 85, "neutral")]) {
      const db = svc([row("old", market, 99), next]);
      expect(await loadFreshEntrySignals(db, market, 60)).toEqual([]);
      expect(db.q.eq.mock.calls).not.toContainEqual(["direction", "long"]);
      expect(db.q.eq.mock.calls).not.toContainEqual(["status", "pending"]);
      expect(db.q.gte).toHaveBeenCalledWith("created_at", "2026-10-21T04:00:00Z");
      expect(db.q.eq).toHaveBeenCalledWith("score_source", "deterministic_v1");
      expect(db.q.eq).toHaveBeenCalledWith("session_validated", true);
    }
  });
  it("does not fall back to yesterday when the market cutoff cannot be certified", async () => {
    const db = svc([], null);
    await expect(loadFreshEntrySignals(db, "us", 60)).rejects.toThrow("Cannot certify");
    expect(db.from).not.toHaveBeenCalled();
  });
  it("retains a newer completed assessment so callers cannot resurrect an old pending one", async () => {
    const db = svc([row("old", "us", 99), row("new", "us", 72, "long", "paper_traded")]);
    const result = await loadFreshEntrySignals(db, "us", 60);
    expect(result.map(r => r.id)).toEqual(["new"]);
    expect(result.filter(r => r.status === "pending")).toEqual([]);
  });
});
