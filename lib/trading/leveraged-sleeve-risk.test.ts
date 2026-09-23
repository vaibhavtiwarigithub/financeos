import { describe, it, expect } from "vitest";
import { leveragedSleeveHeadroom, LEVERAGED_SLEEVE_MAX_NAV_FRACTION } from "./leveraged-sleeve-risk";

describe("leveragedSleeveHeadroom", () => {
  it("full headroom with no existing leveraged positions", () => {
    const r = leveragedSleeveHeadroom({ nav: 10000, positions: [{ symbol: "AAPL", marketValue: 5000 }] });
    expect(r).toEqual({ ok: true, headroom: 10000 * LEVERAGED_SLEEVE_MAX_NAV_FRACTION });
  });

  it("subtracts SOXL and TQQQ combined, ignores other symbols", () => {
    const r = leveragedSleeveHeadroom({
      nav: 10000,
      positions: [{ symbol: "SOXL", marketValue: 300 }, { symbol: "TQQQ", marketValue: 100 }, { symbol: "AAPL", marketValue: 9000 }],
    });
    expect(r).toEqual({ ok: true, headroom: 100 }); // 500 cap - 400 existing
  });

  it("floors at zero, never negative", () => {
    const r = leveragedSleeveHeadroom({ nav: 10000, positions: [{ symbol: "SOXL", marketValue: 900 }] });
    expect(r).toEqual({ ok: true, headroom: 0 });
  });

  it("fails closed on invalid nav or a bad mark", () => {
    expect(leveragedSleeveHeadroom({ nav: 0, positions: [] })).toEqual({ ok: false, reason: "invalid_nav" });
    expect(leveragedSleeveHeadroom({ nav: NaN, positions: [] })).toEqual({ ok: false, reason: "invalid_nav" });
    expect(leveragedSleeveHeadroom({ nav: 10000, positions: [{ symbol: "SOXL", marketValue: -1 }] }))
      .toEqual({ ok: false, reason: "invalid_position_mark" });
  });
});
