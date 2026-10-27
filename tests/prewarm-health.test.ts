import { describe, expect, it } from "vitest";
import { formatPrewarmFailureSymbols } from "@/lib/monitoring/prewarm-health";

describe("price prewarm health details", () => {
  it("names failed and deferred symbols with bounded output", () => {
    expect(formatPrewarmFailureSymbols({
      failed: 2,
      skipped: 1,
      failedSymbols: ["RELIANCE.NS", "bad symbol"],
      skippedSymbols: ["TCS.NS"],
    })).toBe("Unrefreshed symbols: failed:RELIANCE.NS, deferred:TCS.NS; 1 more omitted.");
  });

  it("does not invent identities when only counts are available", () => {
    expect(formatPrewarmFailureSymbols({ failed: 4, skipped: 0 })).toBe(
      "Unrefreshed symbol identities unavailable (4 affected).",
    );
  });

  it("keeps successful results explicit", () => {
    expect(formatPrewarmFailureSymbols({ failed: 0, skipped: 0 })).toBe("No unrefreshed symbols.");
  });
});
