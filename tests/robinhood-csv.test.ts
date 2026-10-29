import { describe, expect, it } from "vitest";
import { parseRobinhoodCSV } from "@/lib/trades/robinhood-csv";

describe("Robinhood CSV parsing", () => {
  it("handles BOM, CRLF, quoted commas, embedded line breaks and escaped quotes", () => {
    const csv = '\uFEFFActivity Date,Instrument,Trans Code,Quantity,Price,Description\r\n' +
      '2026-10-01,"BRK, B",Buy,"2",$500.25,"Broker said ""filled""\r\nacross lines"\r\n';
    expect(parseRobinhoodCSV(csv)).toEqual([
      { date: "2026-10-01", symbol: "BRK, B", action: "buy", qty: 2, price: 500.25 },
    ]);
  });

  it("accepts supported date/header variants and applies known symbol renames", () => {
    const csv = "Date,Symbol,Type,Qty,Price\n10/2/2026,FB,Sell,1.5,700\n";
    expect(parseRobinhoodCSV(csv)).toEqual([
      { date: "2026-10-02", symbol: "META", action: "sell", qty: 1.5, price: 700 },
    ]);
  });

  it("ignores non-trade activity but refuses malformed supported trade rows", () => {
    expect(parseRobinhoodCSV("date,symbol,type,qty,price\n2026-10-01,ABC,DIV,1,1\n")).toEqual([]);
    expect(() => parseRobinhoodCSV("date,symbol,type,qty,price\n2026-10-01,ABC,BUY,1\n"))
      .toThrow(/invalid date, symbol, quantity, or price/);
  });

  it("rejects unterminated quotes and invalid calendar dates", () => {
    expect(() => parseRobinhoodCSV('date,symbol,type,qty,price\n2026-10-01,"ABC,BUY,1,2'))
      .toThrow(/unterminated quoted field/);
    expect(() => parseRobinhoodCSV("date,symbol,type,qty,price\n2026-02-30,ABC,BUY,1,2"))
      .toThrow(/invalid date/);
  });
});
