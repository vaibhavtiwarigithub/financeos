import { describe, it, expect } from "vitest";
import { decideCryptoExit } from "./crypto-exit-policy";

describe("decideCryptoExit", () => {
  it("triggers stop when the daily low reaches the stop, even if the close recovers", () => {
    expect(decideCryptoExit({ closePrice: 100, lowPrice: 90, highPrice: 105, stopLoss: 90, priceTarget: 120 })).toBe("stop");
    expect(decideCryptoExit({ closePrice: 100, lowPrice: 85, highPrice: 105, stopLoss: 90, priceTarget: 120 })).toBe("stop");
  });

  it("triggers target when the daily high reaches the target, even if the close retreats", () => {
    expect(decideCryptoExit({ closePrice: 100, lowPrice: 95, highPrice: 120, stopLoss: 90, priceTarget: 120 })).toBe("target");
  });

  it("takes the adverse stop outcome when the same daily bar touches both levels", () => {
    expect(decideCryptoExit({ closePrice: 110, lowPrice: 89, highPrice: 121, stopLoss: 90, priceTarget: 120 })).toBe("stop");
  });

  it("does not introduce a clock-based exit", () => {
    expect(decideCryptoExit({ closePrice: 100, lowPrice: 95, highPrice: 105, stopLoss: 90, priceTarget: 120 })).toBeNull();
  });

  it("never exits on a missing stop/target level alone", () => {
    expect(decideCryptoExit({ closePrice: 50, lowPrice: 40, highPrice: 110, stopLoss: null, priceTarget: null })).toBeNull();
  });
});
