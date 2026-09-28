import { describe, expect, it } from "vitest";
import { booksFromLast, buildSeedSnapshotInput, buildStepSnapshotInput, historyFromRows } from "@/lib/shadows/atr-forward-collector";
import { buildShadowBookSnapshot } from "@/lib/shadows/shadow-book-ledger";
import { buildAtrReplaySeed } from "@/lib/shadows/atr-replay-seed";

const seed = buildAtrReplaySeed({
  market: "us", session: "2026-09-25", cashBalance: 500, reportedNav: 1500,
  positions: [{ symbol: "ABC", market: "us", qty: 10, avg_cost: 90, current_price: 100, stop_loss: 92, initial_stop_loss: 88, price_target: 120, highest_price: 101 }],
  openLots: [{ symbol: "ABC", market: "us", qty: 10, order_side: "buy", closed_at: null }],
});

function seedRow() {
  return buildShadowBookSnapshot(buildSeedSnapshotInput({ market: "us", session: "2026-09-25", seed, benchmarkClose: 500 }));
}

describe("ATR forward collector snapshot inputs", () => {
  it("builds a valid seed-only snapshot that can never be measured", () => {
    const row = seedRow();
    expect(row.program_id).toBe("exit-stop-shadow");
    expect(row.blockers.join(" ")).toContain("Seed anchor only");
    expect(row.independent_blocks).toBe(0);
    expect(row.baseline_nav).toBeCloseTo(1500);
    expect(row.variant_nav).toBeCloseTo(1500);
    expect((row.point_in_time_inputs as any).sessionMark.benchmarkClose).toBe(500);
  });

  it("extends the persisted history by one session and stays internally consistent", () => {
    const first = seedRow();
    const history = historyFromRows([first]);
    const books = booksFromLast(history);
    expect(books.baseline.positions[0]).toMatchObject({ symbol: "ABC", quantity: 10 });

    const next = { ...history.last.baseline_state, session: "2026-09-28" };
    const input = buildStepSnapshotInput({
      history, market: "us", session: "2026-09-28", sessionsAfterSeed: ["2026-09-28"],
      baselineState: next, variantState: { ...history.last.variant_state, session: "2026-09-28" },
      mark: { prices: { ABC: 102 }, benchmarkClose: 505 }, turnoverNotional: 0, newDecisionIds: [],
    });
    const row = buildShadowBookSnapshot(input);
    expect(row.session_date).toBe("2026-09-28");
    expect(row.window_start).toBe("2026-09-25");
    expect(row.baseline_nav).toBeCloseTo(500 + 10 * 102);
    expect(row.benchmark_cumulative_return_pct).toBeCloseTo((505 / 500 - 1) * 100);
    expect(row.blockers.join(" ")).not.toContain("Seed anchor only");
    expect(row.blockers.join(" ")).toContain("Fewer than two complete non-overlapping return blocks");

    const rebuilt = historyFromRows([first, row as any]);
    expect(rebuilt.sessions).toEqual(["2026-09-25", "2026-09-28"]);
    expect(rebuilt.decisionIds).toEqual(["seed-position:ABC"]);
  });

  it("refuses to rebuild history from a row without its persisted mark", () => {
    const broken = { ...seedRow(), point_in_time_inputs: { decisionIds: [], cumulativeTurnoverNotional: 0 } };
    expect(() => historyFromRows([broken as any])).toThrow("lacks its persisted session mark");
    expect(() => historyFromRows([])).toThrow("No prior snapshots");
  });

  it("refuses a window whose first row is not the seed anchor", () => {
    expect(() => historyFromRows([{ ...seedRow(), window_start: "2026-09-24" } as any])).toThrow("seed anchor");
  });
});
