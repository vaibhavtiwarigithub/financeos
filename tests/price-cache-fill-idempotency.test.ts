import { describe, it, expect } from "vitest";
import { fillCoverage, shouldSkipFill } from "@/lib/markets/price-cache-universe";

// A representative slice: regime bellwether + sector XLs + a leveraged pair.
const UNIVERSE = ["SPY", "QQQ", "DIA", "XLK", "XLF", "XLE", "TQQQ", "SQQQ"] as const;

describe("price-cache-fill idempotency skip", () => {
  it("skips only when the ENTIRE universe has the session", () => {
    expect(shouldSkipFill(UNIVERSE, UNIVERSE)).toBe(true);
  });

  it("does NOT skip when a single marker is fresh but others are stale", () => {
    // The exact prod bug (2026-07-17): SPY advanced off-schedule, the SPY-only
    // probe then skipped the whole fill, freezing XLK/QQQ/DIA a session behind.
    expect(shouldSkipFill(["SPY"], UNIVERSE)).toBe(false);
  });

  it("does NOT skip when all-but-one are fresh", () => {
    expect(shouldSkipFill(UNIVERSE.slice(1), UNIVERSE)).toBe(false);
  });

  it("ignores extra fresh symbols outside the universe", () => {
    expect(shouldSkipFill([...UNIVERSE, "MSFT", "NVDA"], UNIVERSE)).toBe(true);
  });

  it("empty fresh set never skips", () => {
    expect(shouldSkipFill([], UNIVERSE)).toBe(false);
  });
});

describe("price-cache-fill coverage reporting", () => {
  it("counts a symbol an EARLIER tick cached, not just what this tick fetched", () => {
    // The prod false alarm (2026-07-17): the per-symbol fallback fetched 3
    // symbols because the other 28 were already fresh, and the alert then named
    // those 28 as Missing with "tiles may show —". Coverage is a cache
    // property; a tick that fetches nothing because nothing is stale is fine.
    const { missing, coverage } = fillCoverage(UNIVERSE, UNIVERSE);
    expect(missing).toEqual([]);
    expect(coverage).toBe(1);
  });

  it("reports only the genuinely uncached symbols", () => {
    const { missing, coverage } = fillCoverage(["SPY", "QQQ", "DIA", "XLK", "XLF", "XLE"], UNIVERSE);
    expect(missing).toEqual(["TQQQ", "SQQQ"]);
    expect(coverage).toBeCloseTo(0.75);
  });

  it("an empty cache is full coverage loss, not a divide-by-zero", () => {
    expect(fillCoverage([], UNIVERSE)).toEqual({ missing: [...UNIVERSE], coverage: 0 });
    expect(fillCoverage([], []).coverage).toBe(1);
  });
});
