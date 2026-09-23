import { describe, expect, it } from "vitest";
import { isLeveragedInverseEtf, isSymbolBlocked } from "@/lib/trading/symbol-policy";

describe("generic tradable-universe policy", () => {
  it.each(["SH", "PSQ", "DOG", "RWM", "SQQQ", "TQQQ"])(
    "blocks inverse or leveraged ETF %s from generic agents",
    (symbol) => expect(isLeveragedInverseEtf(symbol)).toBe(true),
  );

  it("normalizes symbol casing and whitespace", () => {
    expect(isLeveragedInverseEtf("  sh ")).toBe(true);
  });

  it("does not block an ordinary broad-market ETF", () => {
    expect(isLeveragedInverseEtf("VOO")).toBe(false);
  });

  it.each(["SKHYV", "HXSCL", "HXSCF"])("blocks unsupported ADR proxy %s before a DB read", async (symbol) => {
    const from = () => { throw new Error("DB must not be read"); };
    await expect(isSymbolBlocked({ from } as any, symbol, "us", { failClosed: true }))
      .resolves.toMatchObject({ blocked: true });
  });

  function noBlocklistHit() {
    return {
      from: () => ({
        select: () => ({ in: () => Promise.resolve({ data: [], error: null }) }),
      }),
    } as any;
  }

  it("default behavior (no leveragedSleeveCaller option) blocks TQQQ exactly as before — the L4 carve-out changes nothing for existing callers", async () => {
    await expect(isSymbolBlocked(noBlocklistHit(), "TQQQ", "us"))
      .resolves.toMatchObject({ blocked: true, reason: expect.stringContaining("leveraged/inverse") });
  });

  it("leveragedSleeveCaller exempts exactly SOXL/TQQQ/SQQQ/SOXS, nothing else", async () => {
    for (const symbol of ["SOXL", "TQQQ", "SQQQ", "SOXS"]) {
      await expect(isSymbolBlocked(noBlocklistHit(), symbol, "us", { leveragedSleeveCaller: true }))
        .resolves.toEqual({ blocked: false });
    }
    // A different leveraged/inverse ETF outside the named four is still blocked
    // even with the flag set — this is a four-symbol carve-out, not a blanket relaxation.
    await expect(isSymbolBlocked(noBlocklistHit(), "QLD", "us", { leveragedSleeveCaller: true }))
      .resolves.toMatchObject({ blocked: true });
  });
});
