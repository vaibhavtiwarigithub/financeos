import { describe, expect, it } from "vitest";
import { parseNifty50ConstituentsCsv } from "@/lib/nifty50-constituents";

const tickers = Array.from({ length: 50 }, (_, index) => `SYM${String(index + 1).padStart(2, "0")}`);
const csv = (symbols = tickers) => [
  "Company Name,Industry,Symbol,Series,ISIN Code",
  ...symbols.map((symbol, index) => `\"Company ${index + 1}, Ltd.\",Industry,${symbol},EQ,IN0000000000`),
].join("\n");

describe("parseNifty50ConstituentsCsv", () => {
  it("reads exactly 50 EQ constituents from the official header format", () => {
    const result = parseNifty50ConstituentsCsv(`\uFEFF${csv()}`);
    expect(result).toHaveLength(50);
    expect(result?.[0]).toBe("SYM01.NS");
    expect(result?.[49]).toBe("SYM50.NS");
  });

  it("fails closed on a partial list, duplicate symbols, or an unexpected schema", () => {
    expect(parseNifty50ConstituentsCsv(csv(tickers.slice(0, 49)))).toBeNull();
    expect(parseNifty50ConstituentsCsv(csv([...tickers.slice(0, 49), tickers[0]]))).toBeNull();
    expect(parseNifty50ConstituentsCsv("blocked\nhtml" )).toBeNull();
    expect(parseNifty50ConstituentsCsv(`Company Name,Industry,Symbol\n${tickers.join(",")}`)).toBeNull();
  });

  it("does not silently accept malformed rows or unexpected ticker characters", () => {
    const malformed = csv().replace("SYM10,EQ", "BAD.TICKER,EQ");
    expect(parseNifty50ConstituentsCsv(malformed)).toBeNull();
  });
});
