import { describe, expect, it } from "vitest";
import { evaluateGuardianProtection } from "@/lib/trading/guardian-protection";

const armed = { id: 1, symbol: "INTC", qty: 10, stopPrice: 20, status: "armed" as const };

describe("Manual Trade Guardian protection decision", () => {
  it("does not turn owner arming into an order decision", () => {
    expect(evaluateGuardianProtection({ ...armed, status: "pending_approval" }, 10)).toEqual({ action: "skip", reason: "not_armed" });
  });
  it("triggers at or below the committed stop and never above it", () => {
    expect(evaluateGuardianProtection(armed, 20)).toEqual({ action: "trigger", reason: "stop_breached" });
    expect(evaluateGuardianProtection(armed, 20.01)).toEqual({ action: "skip", reason: "above_stop" });
  });
  it("refuses to decide from an invalid price", () => {
    expect(evaluateGuardianProtection(armed, null)).toEqual({ action: "skip", reason: "invalid_quote" });
    expect(evaluateGuardianProtection(armed, 0)).toEqual({ action: "skip", reason: "invalid_quote" });
  });
});
