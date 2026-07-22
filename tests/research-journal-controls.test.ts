import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyScoreTrackerSelection,
  chunkScoreTrackerSymbols,
  JOURNAL_ALL_DATES_LIMIT,
  normalizeJournalSymbol,
  SCORE_TRACKER_MAX_SYMBOLS,
} from "@/lib/research/journal-controls";

describe("research journal controls", () => {
  it("normalizes exact symbol filters and rejects unsafe input", () => {
    expect(normalizeJournalSymbol(" avgo ")).toBe("AVGO");
    expect(normalizeJournalSymbol("RELIANCE.NS")).toBe("RELIANCE.NS");
    expect(normalizeJournalSymbol("AVGO,MSFT")).toBeNull();
    expect(normalizeJournalSymbol("x".repeat(25))).toBeNull();
  });

  it("keeps all-date reads and score requests explicitly bounded", () => {
    expect(JOURNAL_ALL_DATES_LIMIT).toBe(250);
    const symbols = Array.from({ length: 121 }, (_, i) => `S${i}`);
    expect(chunkScoreTrackerSymbols(symbols).map(chunk => chunk.length)).toEqual([50, 50, 21]);
  });

  it("replaces, adds, and clears chart selection without exceeding the API ceiling", () => {
    expect(applyScoreTrackerSelection(["OLD"], ["AVGO", "MSFT"], "replace")).toEqual(["AVGO", "MSFT"]);
    expect(applyScoreTrackerSelection(["AVGO"], ["MSFT", "AVGO"], "add")).toEqual(["AVGO", "MSFT"]);
    expect(applyScoreTrackerSelection(["AVGO"], [], "clear")).toEqual([]);
    const many = Array.from({ length: 70 }, (_, i) => `S${i}`);
    expect(applyScoreTrackerSelection([], many, "replace")).toHaveLength(SCORE_TRACKER_MAX_SYMBOLS);
  });

  it("keeps picker candidates and saved selections market-scoped", () => {
    const source = readFileSync(join(process.cwd(), "components/dashboard/ScoreTrackerPanel.tsx"), "utf8");
    expect(source).toContain('`${STORAGE_KEY}-${market}`');
    expect(source).toContain('market === "us"');
    expect(source).toContain('fetch("/api/live-portfolio")');
  });
});
