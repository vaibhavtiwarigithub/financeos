import { expect, it } from "vitest";
import { evaluateFreshness, FRESHNESS_CONTRACTS } from "@/lib/monitoring/freshness-contracts";
it("explains the required session instead of contradicting a 96-hour grace", () => {
  const c = FRESHNESS_CONTRACTS.find(c => c.id === "price-cache-us-symbols")!;
  const r = evaluateFreshness(c, [{ scope: "AAPL", watermark: "2026-10-22" }], new Date("2026-10-24T12:00:00Z"));
  expect(r.breached).toBe(true);
  expect(r.detail).toContain("required completed session 2026-10-23");
  expect(r.detail).not.toContain("96h grace");
});
it("retains rolling grace for timestamp contracts", () => {
  const c = { ...FRESHNESS_CONTRACTS[0], sessionAware: false, watermarkType: "timestamp" as const, graceHours: 2 };
  const r = evaluateFreshness(c, [{ scope: "AAPL", watermark: "2026-10-24T08:00:00Z" }], new Date("2026-10-24T12:00:00Z"));
  expect(r.breached).toBe(true);
  expect(r.detail).toContain("2h grace");
});
