import { describe, expect, it } from "vitest";
import { US_BUCKETS, buildScreenerQuery, isScreenableUsSymbol } from "@/lib/data/yahoo-screener";

const clausesOf = (id: "momentum" | "value") =>
  US_BUCKETS.find(b => b.id === id)!.clauses.map(c => [c.operator, ...(c.operands as any[])]);

const threshold = (id: "momentum" | "value", field: string, op: "gt" | "lt") => {
  const c = US_BUCKETS.find(b => b.id === id)!.clauses
    .find(c => c.operator === op && (c.operands as any[])[0] === field);
  return c ? (c.operands as any[])[1] : undefined;
};

describe("Yahoo US screener buckets", () => {
  // Yahoo expresses these as percentages. A ratio passed unconverted (0.15 for
  // 15%) matches essentially everything and disables the leg WITHOUT erroring —
  // the screen still returns names, just not the ones it claims to.
  it("uses percent-scaled thresholds, not ratios", () => {
    expect(threshold("momentum", "quarterlyrevenuegrowth.quarterly", "gt")).toBe(15);
    expect(threshold("momentum", "epsgrowth.lasttwelvemonths", "gt")).toBe(10);
    expect(threshold("momentum", "grossprofitmargin.lasttwelvemonths", "gt")).toBe(25);
    expect(threshold("momentum", "returnonequity.lasttwelvemonths", "gt")).toBe(15);
    // debt/equity < 1.0 is expressed as < 100.
    expect(threshold("value", "totaldebtequity.lasttwelvemonths", "lt")).toBe(100);
  });

  it("keeps the market-cap floors in absolute dollars", () => {
    expect(threshold("momentum", "intradaymarketcap", "gt")).toBe(2_000_000_000);
    expect(threshold("value", "intradaymarketcap", "gt")).toBe(1_000_000_000);
  });

  it("preserves the FinancialDatasets P/E band", () => {
    expect(threshold("value", "peratio.lasttwelvemonths", "gt")).toBe(0);
    expect(threshold("value", "peratio.lasttwelvemonths", "lt")).toBe(18);
  });

  // The provider accepts this criterion and discards it — an absurd threshold
  // returns the same count as no filter. Shipping it would imply a cash-flow
  // screen that does not exist.
  it("ships no free-cash-flow criterion in any bucket", () => {
    const allFields = US_BUCKETS.flatMap(b => b.clauses.map(c => String((c.operands as any[])[0])));
    expect(allFields).not.toContain("freecashflow.lasttwelvemonths");
    // netincomemargin is honoured by the provider but is earnings-derived, so it
    // is not an independent substitute for a cash-flow check.
    expect(allFields).not.toContain("netincomemargin.lasttwelvemonths");
  });

  it("always applies the exchange and volume base clause", () => {
    // region=us alone admits OTC issues and preferred series that the broker
    // cannot fill. The base clause is not caller-supplied.
    const q = buildScreenerQuery(clausesOf("value") as any, 5, "peratio.lasttwelvemonths", "ASC");
    const json = JSON.stringify(q.query);
    expect(json).toContain("NMS");
    expect(json).toContain("NYQ");
    expect(json).toContain("dayvolume");
  });
});

describe("isScreenableUsSymbol", () => {
  it("accepts ordinary listed common stock", () => {
    for (const s of ["MU", "NVDA", "CRDO", "BE", "IAG"]) expect(isScreenableUsSymbol(s)).toBe(true);
  });

  it("rejects preferred and class series", () => {
    // Measured in the raw screener output: NLY-PF and NLY-PG came back alongside
    // NLY. A preferred series is not the security the score describes.
    for (const s of ["NLY-PF", "NLY-PG", "BRK-B"]) expect(isScreenableUsSymbol(s)).toBe(false);
  });

  it("rejects units, warrants and over-long OTC tickers", () => {
    for (const s of ["ABCD.U", "XYZ.WS", "GGPSFX", ""]) expect(isScreenableUsSymbol(s)).toBe(false);
  });
});
