import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { evaluateLeveragedIntraday, leveragedPaperEntryWindow, leveragedPaperSessionOpen, leveragedPaperExitDue, leveragedPaperTrailMode, leveragedPaperRunSummary } from "@/lib/trading/leveraged-intraday";
import { parseAlpacaIntradayBars, type IntradayBar } from "@/lib/data/alpaca-market-data";
import { predictionOnlyEvidence, COUNCIL_PREDICTION_GUIDANCE, COUNCIL_PREDICTION_VERSION, councilVersionedSeriesKey } from "@/lib/llm-council/core";
import { leveragedOpposingExposure } from "@/lib/trading/leveraged-sleeve-risk";
import { buildFormulaLineage } from "@/lib/scoring/formula-lineage";
import { planSoxsEntry, monitorSoxs } from "@/lib/trading/soxs-lifecycle";
import { planSoxlEntry, monitorSoxl } from "@/lib/trading/soxl-lifecycle";
import { planTqqqEntry, monitorTqqq } from "@/lib/trading/tqqq-lifecycle";
import { planSqqqEntry, monitorSqqq } from "@/lib/trading/sqqq-lifecycle";

const bar = (at: string, close = 100): IntradayBar => ({ at, date: at.slice(0, 10), open: close,
  close, high: close + .5, low: close - .5, volume: 100, vwap: close });
const current = () => [0, 5, 10, 15].map((m, i) => bar(`2026-10-22T13:${30 + m}:00Z`, i === 3 ? 103 : 100));
const history = () => [
  ...["2026-10-19", "2026-10-20", "2026-10-21"].flatMap(date => [30, 35, 40, 45].map(m => bar(`${date}T13:${m}:00Z`))),
  ...Array.from({ length: 14 }, (_, i) => bar(new Date(Date.parse("2026-10-21T18:50:00Z") + i * 300000).toISOString())),
];
const now = new Date("2026-10-22T13:50:03Z");

const lifecycles = [
  { symbol: "SOXL", plan: planSoxlEntry, monitor: monitorSoxl },
  { symbol: "SOXS", plan: planSoxsEntry, monitor: monitorSoxs },
  { symbol: "TQQQ", plan: planTqqqEntry, monitor: monitorTqqq },
  { symbol: "SQQQ", plan: planSqqqEntry, monitor: monitorSqqq },
];
describe.each(lifecycles)("$symbol target/trail parity", ({ symbol, plan, monitor }) => {
  const policyVersion = `${symbol.toLowerCase()}-paper-intraday-v3`;
  it("rounds the full-risk target upward at a decimal boundary", () => {
    const result = plan({ policy: { version: policyVersion, maxQuoteAgeMs: 60000, maxSpreadBps: 50,
      maxMonitorAgeMs: 60000, atrStopMultiple: 2, maxStopPct: 12, targetAtrMultiple: 3,
      riskBudgetPct: 1, semiconductorCapPct: 20 }, now: 100000,
      quote: { bid: 100.1, ask: 100.1, observedAt: 99000 }, signalAt: 99000, lastExitAt: null,
      signalSession: "2026-10-21", expectedSignalSession: "2026-10-21", entryWindowOpen: true,
      monitorVerifiedAt: 99000, trendQualified: true, atr: .2, structuralStop: 99.7,
      nav: 10000, cash: 1000, holdings: [], leveragedSleevePositions: [] });
    expect(result).toMatchObject({ ok: true, target: 100.9 });
    if (result.ok) expect(result.target - result.entry).toBeGreaterThanOrEqual(2 * (result.entry - result.stop));
  });
  const position = { market: "us" as const, qty: 10, avgEntry: 100, initialStopLoss: 99.7,
    currentStop: 99.7, highestPrice: 101, priceTarget: 102, partialTaken: false };
  const input = { now: 100000, maxQuoteAgeMs: 60000,
    quote: { price: 100.6, dayLow: null, dayHigh: null, observedAt: 99000 }, thesisInvalidated: false };
  it("uses recorded sub-1% risk for intraday protection, not the stock trail floor", () => {
    const result = monitor({ ...input, position: { ...position, trailMode: leveragedPaperTrailMode(policyVersion) } });
    expect(result).toMatchObject({ action: "stop_full", exitQty: 10 });
    if ("trailingStop" in result) expect(result.trailingStop).toBeCloseTo(100.697);
  });
  it("preserves legacy policy rather than silently migrating historical lots", () => {
    expect(monitor({ ...input, position })).toMatchObject({ action: "none" });
    expect(leveragedPaperTrailMode(null)).toBeUndefined();
    expect(leveragedPaperTrailMode(`${symbol.toLowerCase()}-paper-v2`)).toBeUndefined();
    expect(leveragedPaperTrailMode("unrecognized-paper-intraday-v3")).toBeUndefined();
  });
  it("never loosens an existing stop and prioritizes it over a target", () => {
    expect(monitor({ ...input, position: { ...position, currentStop: 100.8, priceTarget: 100.5,
      trailMode: leveragedPaperTrailMode(policyVersion) } })).toMatchObject({ action: "stop_full", trailingStop: 100.8 });
  });
  it("does not apply a newly ratcheted high retroactively to this observation's low", () => {
    const result = monitor({ ...input, quote: { ...input.quote, price: 101, dayLow: 100.1 },
      position: { ...position, highestPrice: 100, trailMode: leveragedPaperTrailMode(policyVersion) } });
    expect(result).toMatchObject({ action: "none" });
    if ("trailingStop" in result) expect(result.trailingStop).toBeCloseTo(100.697);
  });
});

describe("shared leveraged intraday contract", () => {
  it("preserves structured summaries beyond the old 500-character cut", () => {
    const body = { status: "no_entry", reason: "proxy_direction_not_confirmed", monitorVerified: true,
      setup: { evidence: "x".repeat(1500), unmet_conditions: ["proxy_direction_not_confirmed"] } };
    const summary = leveragedPaperRunSummary(body);
    expect(summary.length).toBeGreaterThan(500);
    expect(JSON.parse(summary)).toEqual(body);
  });
  it("discloses oversized summaries without corrupting JSON or dropping liveness", () => {
    const summary = leveragedPaperRunSummary({ status: "no_entry", reason: "wait", monitorVerified: true,
      setup: "x".repeat(9000) });
    expect(summary.length).toBeLessThanOrEqual(8000);
    expect(JSON.parse(summary)).toEqual({ status: "no_entry", reason: "wait", monitorVerified: true, summary_truncated: true });
    expect(JSON.parse(leveragedPaperRunSummary({ setup: "x".repeat(9000) })).monitorVerified).toBe(false);
  });
  it.each(["2026-10-22T13:44:59Z", "2026-10-22T19:30:00Z", "2026-10-24T14:00:00Z", "2026-11-27T17:30:00Z"])("blocks entry at %s", time => {
    expect(leveragedPaperEntryWindow(new Date(time))).toBe(false);
  });
  it.each(["2026-10-22T13:45:00Z", "2026-12-16T14:45:00Z", "2026-11-27T17:29:59Z"])("supports DST/early close at %s", time => {
    expect(leveragedPaperEntryWindow(new Date(time))).toBe(true);
  });
  it("refuses after-close and unsupported calendars", () => {
    expect(leveragedPaperSessionOpen(new Date("2026-10-22T20:00:00Z"))).toBe(false);
    expect(leveragedPaperSessionOpen(new Date("2027-10-22T14:00:00Z"))).toBe(false);
  });
  it("ends new intraday lots before the close without rewriting legacy swing lots", () => {
    expect(leveragedPaperExitDue(new Date("2026-10-22T19:45:00Z"), "soxl-paper-intraday-v3")).toBe(true);
    expect(leveragedPaperExitDue(new Date("2026-10-22T19:44:59Z"), "soxl-paper-intraday-v3")).toBe(false);
    expect(leveragedPaperExitDue(new Date("2026-11-27T17:45:00Z"), "soxs-paper-intraday-v3")).toBe(true);
    expect(leveragedPaperExitDue(new Date("2026-10-22T19:45:00Z"), null)).toBe(false);
  });
  it("uses a common completed opening-range setup and explicit proxy", () => {
    const result = evaluateLeveragedIntraday("SOXL", [...history(), ...current()], current(), now);
    expect(result).toMatchObject({ state: "ready", signalAt: Date.parse("2026-10-22T13:50:00Z") });
    expect(result.evidence).toMatchObject({ proxy: "SOXX", partial_venue: true, proxy_confirmed: true });
  });
  it("inverse funds require a FALLING proxy, not the long fund's trend", () => {
    expect(evaluateLeveragedIntraday("SOXS", [...history(), ...current()], current(), now)).toMatchObject({
      state: "wait", reason: "proxy_direction_not_confirmed", evidence: {
        etf_opening_range_confirmed: true, etf_vwap_confirmed: true, relative_volume_confirmed: true,
        unmet_conditions: ["proxy_direction_not_confirmed"],
      },
    });
    const down = current(); down[3] = bar(down[3].at, 97);
    expect(evaluateLeveragedIntraday("SOXS", [...history(), ...current()], down, now).state).toBe("ready");
  });
  it.each(["gap", "stale", "partial", "zero_volume"])("refuses incomplete %s evidence", kind => {
    let rows = current(); let clock = now;
    if (kind === "gap") rows.splice(1, 1);
    if (kind === "stale") clock = new Date("2026-10-22T14:10:01Z");
    if (kind === "partial") clock = new Date("2026-10-22T13:49:00Z");
    if (kind === "zero_volume") rows = rows.map(b => ({ ...b, volume: 0 }));
    expect(evaluateLeveragedIntraday("SOXL", [...history(), ...rows], rows, clock).state).not.toBe("ready");
  });
  it("does not inflate five-minute ATR with the overnight gap", () => {
    const result = evaluateLeveragedIntraday("SOXL", [...history().map(b => ({ ...b, open: 10, high: 10.5, low: 9.5, close: 10 })), ...current()], current(), now);
    expect(result.atr).toBeLessThan(2);
  });
  it("strictly parses OHLCV event time and rejects duplicates/malformed rows", () => {
    const b = { t: "2026-10-22T13:30:00Z", o: 100, h: 101, l: 99, c: 100, v: 5, vw: 100 };
    expect(parseAlpacaIntradayBars({ bars: [b] })[0]).toMatchObject({ at: b.t, vwap: 100 });
    expect(parseAlpacaIntradayBars({ bars: [b, b] })).toEqual([]);
    expect(parseAlpacaIntradayBars({ bars: [{ ...b, c: null }] })).toEqual([]);
  });
  it.each([["SOXL", "SOXS"], ["TQQQ", "SQQQ"], ["SOXS", "SOXL"], ["SQQQ", "TQQQ"]])("blocks opposing %s / %s", (symbol, held) => {
    expect(leveragedOpposingExposure(symbol, [{ symbol: held, marketValue: .001 }])).toMatchObject({ ok: false, reason: "opposing_leveraged_exposure" });
  });
  it("keeps invalidation intact and derives target from FULL risk, not ATR alone", () => {
    const p = planSoxsEntry({ policy: { version: "soxs-paper-intraday-v3", maxQuoteAgeMs: 60000, maxSpreadBps: 50,
      maxMonitorAgeMs: 60000, atrStopMultiple: 2, maxStopPct: 12, targetAtrMultiple: 3, riskBudgetPct: 1 },
      now: 100000, quote: { bid: 100, ask: 100, observedAt: 99000 }, signalAt: 99000, lastExitAt: null,
      signalSession: "2026-10-21", expectedSignalSession: "2026-10-21", entryWindowOpen: true, monitorVerifiedAt: 99000,
      trendQualified: true, atr: 1, structuralStop: 95, nav: 10000, cash: 1000, leveragedSleevePositions: [] });
    expect(p).toMatchObject({ ok: true, stop: 95, target: 110, maxNotional: 500 });
  });
});

describe("prediction is not execution permission", () => {
  it("removes permission leakage without changing the frozen source", () => {
    const source = { features: { instrument: { kind: "leveraged_or_inverse_etf", score_mode: "blocked", new_entry_allowed: false },
      trade_plan: { target_pct: 8 }, technical: { as_of: "2026-10-21", price: 50 } }, deterministic_score: { composite: 65, threshold: 60 } };
    const packet = predictionOnlyEvidence(source);
    expect(packet.features.instrument).toEqual({ kind: "leveraged_or_inverse_etf" });
    expect(packet.features.trade_plan).toBeUndefined();
    expect(packet.features.technical).toEqual(source.features.technical);
    expect(source.features.instrument.score_mode).toBe("blocked");
    expect(COUNCIL_PREDICTION_GUIDANCE).toContain("TEN-session");
    expect(COUNCIL_PREDICTION_VERSION).toContain("v2");
  });
  it("separates leveraged formula identity from unchanged ordinary ETFs", () => {
    expect(buildFormulaLineage({ instrumentFamily: "leveraged_or_inverse_etf" }).versions.composite).toContain("leveraged_uncapped_v2");
    expect(buildFormulaLineage({ instrumentFamily: "thematic_etf" }).versions.composite).toBe("composite_formula_v1_20261021");
  });
  it("never pools new prompt evidence with legacy IC series", () => {
    const key = "composite:availability_median";
    expect(councilVersionedSeriesKey(key, { prompt_version: "council-v1" })).toBe(key);
    expect(councilVersionedSeriesKey(key, { input_snapshot: { prediction_contract: { version: COUNCIL_PREDICTION_VERSION } } })).not.toBe(key);
  });
  it("rechecks opposing/cap admission atomically rather than trusting JS", () => {
    const sql = readFileSync("supabase/migrations/20261023041052_leveraged_intraday_v3_guards.sql", "utf8");
    expect(sql).toContain("for update"); expect(sql).toContain("opposing_leveraged_exposure");
    expect(sql).toContain("v_used+p_cost>v_nav*0.05"); expect(sql).toContain("revoke all");
  });
});
