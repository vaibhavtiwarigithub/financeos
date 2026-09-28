import { describe, expect, it } from "vitest";
import { FRESHNESS_CONTRACTS, evaluateFreshness, requiredPriceScope } from "@/lib/monitoring/freshness-contracts";

const contract = FRESHNESS_CONTRACTS.find((c) => c.id === "price-cache-us-symbols")!;
const rows = (date: string) => ["AAPL", "MSFT"].map((scope) => ({ scope, watermark: date }));

describe("price-cache freshness settle lag", () => {
  it("does not demand the just-closed session before providers and the prewarm can have landed it", () => {
    // Wed 2026-09-23 20:02 UTC = 2 minutes after the EDT close. Bars end Tuesday.
    const result = evaluateFreshness(contract, rows("2026-09-22"), new Date("2026-09-23T20:02:00Z"));
    expect(result.breached).toBe(false);
  });

  it("still demands that session once the settle window has passed", () => {
    // Thu 00:00 UTC is ~4h after the close and after the 21:35 prewarm.
    const late = evaluateFreshness(contract, rows("2026-09-22"), new Date("2026-09-24T00:00:00Z"));
    expect(late.breached).toBe(true);
    const ok = evaluateFreshness(contract, rows("2026-09-23"), new Date("2026-09-24T00:00:00Z"));
    expect(ok.breached).toBe(false);
  });

  it("a genuinely frozen cache is still caught during the settle window", () => {
    // Bars frozen at the prior Friday while it is Wednesday afternoon: two sessions behind even with the lag.
    const frozen = evaluateFreshness(contract, rows("2026-09-18"), new Date("2026-09-23T20:02:00Z"));
    expect(frozen.breached).toBe(true);
  });
});

describe("requiredPriceScope", () => {
  it("drops research-disabled (delisted) names that only have stale decisions, but never a held position", () => {
    const scope = requiredPriceScope(["AAPL", "irbt", "ABB", "MSFT"], ["MSFT", "ABB"], ["IRBT", "ABB"]);
    expect([...scope].sort()).toEqual(["AAPL", "ABB", "MSFT"]);
  });

  it("is a no-op when nothing is disabled", () => {
    expect([...requiredPriceScope(["AAPL"], ["MSFT"], [])].sort()).toEqual(["AAPL", "MSFT"]);
  });
});
