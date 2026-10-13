import { describe, expect, it } from "vitest";
import { INDIA_MACRO_SERIES, fiiDiiToObservations, fredToObservations, nseDateToIso, parseYahooChart } from "@/lib/india-macro-series";

const spec = (id: string) => INDIA_MACRO_SERIES.find((s) => s.id === id)!;
const day = (iso: string) => Math.floor(Date.parse(`${iso}T03:45:00Z`) / 1000);

describe("india macro series", () => {
  it("series ids are unique and each has a provider", () => {
    expect(new Set(INDIA_MACRO_SERIES.map((s) => s.id)).size).toBe(INDIA_MACRO_SERIES.length);
    expect(INDIA_MACRO_SERIES.every((s) => s.provider.length > 0)).toBe(true);
  });
  it("parses Yahoo closes, dropping null bars and the still-forming bar for 24h instruments", () => {
    const json = { chart: { result: [{ timestamp: [day("2026-10-09"), day("2026-10-12"), day("2026-10-13")], indicators: { quote: [{ close: [96.2, null, 96.5] }] } }] } };
    expect(parseYahooChart(spec("usdinr_spot"), json, "2026-10-13")).toEqual([{ series_id: "usdinr_spot", source: "yahoo", obs_date: "2026-10-09", value: 96.2 }]);
    expect(parseYahooChart(spec("india_vix"), json, "2026-10-13").map((o) => o.obs_date)).toEqual(["2026-10-09", "2026-10-13"]);
  });
  it("returns nothing for a malformed Yahoo payload instead of throwing", () => {
    expect(parseYahooChart(spec("india_vix"), { chart: { result: null, error: { code: "x" } } }, "2026-10-13")).toEqual([]);
    expect(parseYahooChart(spec("india_vix"), null, "2026-10-13")).toEqual([]);
  });
  it("keeps only well-formed FRED rows", () => {
    expect(fredToObservations(spec("brent_fred"), [{ date: "2026-10-06", value: 125.44 }, { date: "bad", value: 1 }, { date: "2026-10-05", value: NaN }]))
      .toEqual([{ series_id: "brent_fred", source: "fred", obs_date: "2026-10-06", value: 125.44 }]);
  });
  it("converts NSE dates and FII/DII sessions, skipping unparseable ones", () => {
    expect(nseDateToIso("10-Jul-2026")).toBe("2026-07-10");
    expect(nseDateToIso("garbage")).toBeNull();
    expect(fiiDiiToObservations({ date: "13-Oct-2026", fiiNet: -1200.5, diiNet: null })).toEqual([{ series_id: "fii_net_cr", source: "nse", obs_date: "2026-10-13", value: -1200.5 }]);
    expect(fiiDiiToObservations({ date: null, fiiNet: 1, diiNet: 2 })).toEqual([]);
  });
});
