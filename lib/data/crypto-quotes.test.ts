import { describe, expect, it } from "vitest";
import { fetchCryptoCandles, parseCoinbaseDailyCandles, parseKrakenDailyCandles } from "./crypto-quotes";

const DAY = 86_400;
const start = 1_700_000_000;
const coinbaseRows = (count: number) => Array.from({ length: count }, (_, index) => [start + index * DAY, 99, 105, 100, 102, 12]);
const krakenRows = (count: number) => Array.from({ length: count }, (_, index) => [start + index * DAY, "100", "105", "99", "102", "101", "12", 3]);

describe("crypto public candle adapters", () => {
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

  it("falls through an insufficient Coinbase response to independent Kraken evidence", async () => {
    const result = await fetchCryptoCandles("ETH", "", async (url) => new Response(
      JSON.stringify(url.includes("coinbase") ? coinbaseRows(1) : { result: { XETHZUSD: krakenRows(51), last: start } }), { status: 200 },
    ));
    expect(result.source).toBe("kraken");
    expect(result.attempted).toEqual(["coinbase_exchange", "kraken"]);
    expect(result.candles).toHaveLength(51);
  });
});
