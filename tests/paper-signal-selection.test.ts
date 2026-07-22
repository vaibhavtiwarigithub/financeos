import { describe, expect, it } from "vitest";
import { selectBestPaperSignals } from "@/lib/trading/paper-signal-selection";

const row = (id: string, symbol: string, score: number, created: string, market = "us") => ({
  id, symbol, analyst_score: score, created_at: created, market,
});

describe("paper signal selection", () => {
  it("deduplicates before applying the unique-symbol limit", () => {
    const rows = [
      row("a1", "AAA", 99, "2026-07-22T10:00:00Z"),
      row("a2", "aaa", 98, "2026-07-22T11:00:00Z"),
      row("a3", "AAA", 97, "2026-07-22T12:00:00Z"),
      row("b", "BBB", 96, "2026-07-22T10:00:00Z"),
      row("c", "CCC", 95, "2026-07-22T10:00:00Z"),
    ];
    const result = selectBestPaperSignals(rows, "us", 3);
    expect(result.selected.map(signal => signal.id)).toEqual(["a1", "b", "c"]);
    expect(result.duplicateIds.sort()).toEqual(["a2", "a3"]);
  });

  it("uses newest creation time and then id as deterministic score tie-breaks", () => {
    const rows = [
      row("old", "AAA", 80, "2026-07-22T10:00:00Z"),
      row("new-a", "AAA", 80, "2026-07-22T11:00:00Z"),
      row("new-b", "AAA", 80, "2026-07-22T11:00:00Z"),
    ];
    expect(selectBestPaperSignals(rows, "us", 10).selected[0].id).toBe("new-b");
  });

  it("keeps US and India symbols isolated even when tickers match", () => {
    const rows = [
      row("us", "ABC", 70, "2026-07-22T10:00:00Z", "us"),
      row("in", "ABC", 90, "2026-07-22T10:00:00Z", "india"),
    ];
    expect(selectBestPaperSignals(rows, "us", 10).selected.map(signal => signal.id)).toEqual(["us"]);
    expect(selectBestPaperSignals(rows, "india", 10).selected.map(signal => signal.id)).toEqual(["in"]);
  });
});
