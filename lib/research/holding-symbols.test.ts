import { describe, expect, it } from "vitest";
import { symbolsFromLatestLiveSnapshots, symbolsFromPaperPositions, unionHoldingSymbols, orderHoldingsByStaleness } from "./holding-symbols";

describe("holding research symbols", () => {
  it("uses only the latest snapshot for each live account", () => {
    expect(symbolsFromLatestLiveSnapshots([
      { broker: "robinhood", account_id: "a", captured_at: "2026-07-15", positions_json: [{ symbol: "OLD", qty: 1 }] },
      { broker: "robinhood", account_id: "a", captured_at: "2026-07-16", positions_json: [{ symbol: "AAPL", qty: 2 }] },
      { broker: "robinhood", account_id: "b", captured_at: "2026-07-16", positions_json: [{ symbol: "MSFT", qty: 1 }] },
    ])).toEqual(["AAPL", "MSFT"]);
  });

  it("normalizes positive paper positions per market", () => {
    expect(symbolsFromPaperPositions([{ symbol: "reliance", qty: 2 }, { symbol: "ZERO", qty: 0 }], "india")).toEqual(["RELIANCE.NS"]);
    expect(symbolsFromPaperPositions([{ symbol: "aapl", qty: 1 }], "us")).toEqual(["AAPL"]);
  });

  it("deduplicates paper and live holdings", () => {
    expect(unionHoldingSymbols(["AAPL", "MSFT"], ["aapl", "NVDA"])).toEqual(["AAPL", "MSFT", "NVDA"]);
  });
});

// Regression: 2026-07-16 holdings-starvation bug. Holdings are exempt from the
// candidate cap but NOT from the cron's wall-clock budget. Prod run a4530e8f
// scored batch slots 1-30 and left slots 31-56 (all holdings) at zero — the same
// tail, every run, because the order was stable.
describe("orderHoldingsByStaleness (holdings must rotate under the budget)", () => {
  it("puts never-scored holdings first, then oldest-scored, alphabetical tiebreak", () => {
    const order = orderHoldingsByStaleness(
      ["AVGO", "HOOD", "FEZ", "NEWLY_BOUGHT", "ZZZ"],
      new Map([
        ["AVGO", "2026-07-13T13:00:00Z"],
        ["HOOD", "2026-07-14T13:00:00Z"],
        ["FEZ", "2026-07-16T13:00:00Z"],
        // NEWLY_BOUGHT + ZZZ never scored -> must lead, tiebroken alphabetically.
      ]),
    );
    expect(order).toEqual(["NEWLY_BOUGHT", "ZZZ", "AVGO", "HOOD", "FEZ"]);
  });

  it("treats an explicit null last-scored as never-scored", () => {
    expect(orderHoldingsByStaleness(["A", "B"], new Map([["A", "2026-07-16T13:00:00Z"], ["B", null]])))
      .toEqual(["B", "A"]);
  });

  it("is a pure reordering — never drops or invents a holding", () => {
    const held = ["AVGO", "HOOD", "FEZ", "GLD"];
    expect([...orderHoldingsByStaleness(held, new Map())].sort()).toEqual([...held].sort());
  });

  // THE regression. Replays the real prod shape: a book larger than one run's
  // throughput, scored over many runs. Fails on the pre-fix stable ordering.
  it("covers EVERY holding within ceil(n/throughput) runs instead of starving a fixed tail", () => {
    // 56 holdings, ~30 scored per run — the exact prod ratio on 2026-07-16.
    const book = Array.from({ length: 56 }, (_, i) => `SYM${String(i).padStart(2, "0")}`);
    const THROUGHPUT = 30;
    const lastScoredAt = new Map<string, string | null>();

    const runOnce = (day: number, order: (b: string[]) => string[]) => {
      for (const sym of order(book).slice(0, THROUGHPUT)) {
        lastScoredAt.set(sym, `2026-07-${String(day).padStart(2, "0")}T13:00:00Z`);
      }
    };

    // Pre-fix behavior: a STABLE order (alphabetical, as unionHoldingSymbols
    // returns). The tail can never be reached, no matter how many runs pass.
    for (let day = 1; day <= 10; day++) runOnce(day, (b) => [...b].sort());
    const starvedUnderStableOrder = book.filter((s) => !lastScoredAt.has(s));
    expect(starvedUnderStableOrder.length).toBe(26);   // 56 - 30, permanently invisible
    expect(starvedUnderStableOrder).toContain("SYM54"); // AVGO's slot: owned, never re-scored

    // Post-fix: staleness ordering. Worst-case staleness is bounded by
    // ceil(56/30) = 2 runs, so the whole book is covered — nothing starves.
    lastScoredAt.clear();
    for (let day = 1; day <= 2; day++) runOnce(day, (b) => orderHoldingsByStaleness(b, lastScoredAt));
    expect(book.filter((s) => !lastScoredAt.has(s))).toEqual([]);

    // And it keeps rotating: every holding stays re-scored within 2 runs, so no
    // position can silently go stale for days the way AVGO did (07-13 -> 07-16).
    for (let day = 3; day <= 12; day++) {
      runOnce(day, (b) => orderHoldingsByStaleness(b, lastScoredAt));
      const scoredThisRunOrLast = book.filter((s) => Number((lastScoredAt.get(s) ?? "").slice(8, 10)) >= day - 1);
      expect(scoredThisRunOrLast.length).toBe(book.length);
    }
  });
});
