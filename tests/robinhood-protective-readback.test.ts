import { describe, expect, it } from "vitest";
import { robinhoodCancelIsFinal, verifyRobinhoodRestingStop } from "@/lib/protective/robinhood-readback";

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
});
