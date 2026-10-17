import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { confirmedRobinhoodStopExit, robinhoodCancelIsFinal, verifyRobinhoodRestingStop } from "@/lib/protective/robinhood-readback";

const expected = { symbol: "SOXL", account: "trading-account", qty: 2, stopPrice: 43.25 };
const order = { type: "stop", side: "sell", symbol: "SOXL", account_number: "trading-account", quantity: "2", stop_price: "43.25", time_in_force: "gtc" };

describe("Robinhood protective readback", () => {
  it("requires every order field to match, not just a broker id", () => {
    expect(verifyRobinhoodRestingStop(order, expected)).toBe(true);
    for (const key of Object.keys(order)) {
      const altered = { ...order, [key]: undefined };
      expect(verifyRobinhoodRestingStop(altered, expected), key).toBe(false);
    }
    expect(verifyRobinhoodRestingStop({ ...order, quantity: "3" }, expected)).toBe(false);
    expect(verifyRobinhoodRestingStop({ ...order, stop_price: "42.25" }, expected)).toBe(false);
    expect(verifyRobinhoodRestingStop({ ...order, side: "buy" }, expected)).toBe(false);
  });

  it("requires a final cancellation and zero filled quantity", () => {
    expect(robinhoodCancelIsFinal("canceled", 0)).toBe(true);
    expect(robinhoodCancelIsFinal("submitted", 0)).toBe(false);
    expect(robinhoodCancelIsFinal("canceled", 1)).toBe(false);
    expect(robinhoodCancelIsFinal("canceled", undefined)).toBe(false);
  });

  it("only closes an externally filled stop on exact fill and zero broker holding", () => {
    const state = { status: "filled", filledQty: 2, avgFillPrice: 42, heldReadOk: true, heldQty: 0, expectedQty: 2 };
    expect(confirmedRobinhoodStopExit(state)).toBe(42);
    expect(confirmedRobinhoodStopExit({ ...state, heldQty: 2 })).toBeNull();
    expect(confirmedRobinhoodStopExit({ ...state, filledQty: 1 })).toBeNull();
    expect(confirmedRobinhoodStopExit({ ...state, heldReadOk: false })).toBeNull();
    expect(confirmedRobinhoodStopExit({ ...state, avgFillPrice: undefined })).toBeNull();
  });

  it("does not persist an analytical trail as a broker stop without replacement", () => {
    const route = readFileSync("app/api/agents/leveraged-live/cron/route.ts", "utf8");
    expect(route).not.toContain("stop_loss: parseFloat(decision.trailingStop");
    expect(route).toContain("analyticalTrailingStop: decision.trailingStop, brokerStop:");
  });
});
