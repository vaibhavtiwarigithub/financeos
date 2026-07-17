import { describe, it, expect } from "vitest";
import { shouldSkipFill } from "@/lib/markets/price-cache-universe";

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
