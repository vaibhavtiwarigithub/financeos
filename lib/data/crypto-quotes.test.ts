import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchCryptoCandles, fetchCryptoQuote, parseCoinbaseDailyCandles, parseKrakenDailyCandles } from "./crypto-quotes";

const DAY = 86_400;
const start = Date.UTC(2026, 8, 1) / 1000;
const coinbaseRows = (count: number) => Array.from({ length: count }, (_, index) => [start + index * DAY, 99, 105, 100, 102, 12]);
const krakenRows = (count: number) => Array.from({ length: count }, (_, index) => [start + index * DAY, "100", "105", "99", "102", "101", "12", 3]);

describe("crypto public candle adapters", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-22T12:00:00Z")); });
  afterEach(() => vi.useRealTimers());
  it("normalizes Coinbase's reverse-order OHLC layout into valid daily candles", () => {
    const candles = parseCoinbaseDailyCandles([coinbaseRows(1)[0]]);
    expect(candles).toEqual([{ date: new Date(start * 1000).toISOString().slice(0, 10), open: 100, high: 105, low: 99, close: 102, volume: 12 }]);
  });

  it("normalizes Kraken's result envelope and excludes malformed rows", () => {
    const candles = parseKrakenDailyCandles({ result: { XXBTZUSD: [...krakenRows(1), [start + DAY, "0", "0", "0", "0", "0", "0", 0]], last: start } });
    expect(candles).toHaveLength(1);
    expect(candles[0]?.close).toBe(102);
  });

  it("uses Coinbase first and never spends Alpha Vantage when public evidence is sufficient", async () => {
    const requests: string[] = [];
    const result = await fetchCryptoCandles("BTC", "unused-key", async (url) => {
      requests.push(url);
      return new Response(JSON.stringify(coinbaseRows(51)), { status: 200 });
    });
    expect(result.source).toBe("coinbase_exchange");
    expect(result.candles).toHaveLength(51);
    expect(requests).toEqual(["https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400"]);
  });

  it("uses the broker-selected base symbol for Coinbase rather than a static three-coin universe", async () => {
    const requests: string[] = [];
    const result = await fetchCryptoCandles("DOGE", "", async (url) => {
      requests.push(url);
      return new Response(JSON.stringify(coinbaseRows(51)), { status: 200 });
    });
    expect(result.source).toBe("coinbase_exchange");
    expect(requests).toEqual(["https://api.exchange.coinbase.com/products/DOGE-USD/candles?granularity=86400"]);
  });

  it("falls through an insufficient Coinbase response to independent Kraken evidence", async () => {
    const result = await fetchCryptoCandles("ETH", "", async (url) => new Response(
      JSON.stringify(url.includes("coinbase") ? coinbaseRows(1) : { result: { XETHZUSD: krakenRows(51), last: start } }), { status: 200 },
    ));
    expect(result.source).toBe("kraken");
    expect(result.attempted).toEqual(["coinbase_exchange", "kraken"]);
    expect(result.candles).toHaveLength(51);
  });

  it("uses an independent public two-sided quote for paper evidence", async () => {
    const result = await fetchCryptoQuote("BTC-USD", async () => new Response(JSON.stringify({ bid: "99", ask: "101" }), { status: 200 }));
    expect(result).toMatchObject({ source: "coinbase_exchange", quote: { bid: 99, ask: 101, source: "coinbase_exchange" } });
  });

  it("falls through a long but obsolete Coinbase history to an exact Kraken USD market", async () => {
    const requests: string[] = [];
    const result = await fetchCryptoCandles("LIT-USD", "", async (url) => {
      requests.push(url);
      return new Response(JSON.stringify(url.includes("coinbase")
        ? coinbaseRows(51).map(row => [Number(row[0]) - DAY * 365, ...row.slice(1)])
        : { error: [], result: { LITUSD: krakenRows(51), last: start } }), { status: 200 });
    });
    expect(result.source).toBe("kraken");
    expect(requests[1]).toContain("pair=LITUSD&interval=1440");
  });

  it("rejects stale histories even when they contain enough bars", async () => {
    const result = await fetchCryptoCandles("CC-USD", "", async (url) => new Response(JSON.stringify(
      url.includes("coinbase") ? coinbaseRows(51).slice(0, -1)
        : { error: [], result: { CCUSD: krakenRows(51).map(row => [Number(row[0]) - DAY, ...row.slice(1)]) } },
    ), { status: 200 }));
    expect(result.source).toBe("unavailable");
  });

  it("tries an exact non-core Kraken quote and refuses unknown or crossed markets", async () => {
    const requests: string[] = [];
    const result = await fetchCryptoQuote("CC-USD", async url => {
      requests.push(url);
      return new Response(JSON.stringify(url.includes("coinbase") ? { message: "NotFound" }
        : { error: [], result: { CCUSD: { b: ["1"], a: ["1.01"] } } }), { status: 200 });
    });
    expect(result.source).toBe("kraken");
    expect(requests[1]).toContain("pair=CCUSD");
    const unavailable = await fetchCryptoQuote("CASHCAT-USD", async () =>
      new Response(JSON.stringify({ error: ["EQuery:Unknown asset pair"] }), { status: 200 }));
    expect(unavailable.quote).toBeNull();
  });
});
