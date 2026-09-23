import { describe, it, expect } from "vitest";
import { leveragedSleeveLiveHeadroom } from "./leveraged-sleeve-risk-live";

describe("leveragedSleeveLiveHeadroom", () => {
  it("fails closed on a zero or unset lease (the safe default)", () => {
    expect(leveragedSleeveLiveHeadroom({ leaseUsd: 0, positions: [] })).toEqual({ ok: false, reason: "no_lease_capacity" });
    expect(leveragedSleeveLiveHeadroom({ leaseUsd: NaN, positions: [] })).toEqual({ ok: false, reason: "no_lease_capacity" });
  });
  it("full headroom with no existing live leveraged positions", () => {
    expect(leveragedSleeveLiveHeadroom({ leaseUsd: 200, positions: [{ symbol: "AAPL", marketValue: 5000 }] }))
      .toEqual({ ok: true, headroom: 200 });
  });
  it("subtracts all four leveraged-sleeve symbols combined, ignores others", () => {
    expect(leveragedSleeveLiveHeadroom({
      leaseUsd: 200,
      positions: [{ symbol: "SOXL", marketValue: 80 }, { symbol: "SQQQ", marketValue: 70 }, { symbol: "AAPL", marketValue: 9000 }],
    })).toEqual({ ok: true, headroom: 50 });
  });
  it("floors at zero, never negative", () => {
    expect(leveragedSleeveLiveHeadroom({ leaseUsd: 200, positions: [{ symbol: "SOXL", marketValue: 250 }] }))
      .toEqual({ ok: true, headroom: 0 });
  });
  it("fails closed on a bad mark", () => {
    expect(leveragedSleeveLiveHeadroom({ leaseUsd: 200, positions: [{ symbol: "SOXL", marketValue: -1 }] }))
      .toEqual({ ok: false, reason: "invalid_position_mark" });
  });
});
