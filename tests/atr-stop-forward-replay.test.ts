import { describe, expect, it } from "vitest";
import {
  advanceAtrStopReplaySession,
  atrReplayBookFromShadowState,
  atrReplayBookToShadowState,
  atrStopForEntry,
  type AtrStopReplayBook,
  type AtrStopReplayEntry,
  type AtrStopReplayStepInput,
} from "@/lib/shadows/atr-stop-forward-replay";

const seed = (session = "2026-09-25"): AtrStopReplayBook => ({ market: "us", session, cash: 1_000, positions: [] });
const entry = (overrides: Partial<AtrStopReplayEntry> = {}): AtrStopReplayEntry => ({
  decisionId: "decision-1", symbol: "ABC", session: "2026-09-28", filledAt: "2026-09-28T15:15:00.000Z", quantity: 2,
  fillPrice: 100, baselineStopLoss: 95, priceTarget: 110, atr14AtDecision: 2,
  ...overrides,
});
const step = (overrides: Partial<AtrStopReplayStepInput> = {}): AtrStopReplayStepInput => ({
  market: "us", arm: "baseline", priceBasis: "raw_ohlc", session: "2026-09-28", book: seed(), bars: [], entries: [entry()],
  corporateActions: [], costs: { version: "fixed-sell-5bps-v1", sellCostBps: 5 }, ...overrides,
});

describe("forward ATR-stop portfolio replay", () => {
  it("computes the predeclared 2.8-ATR stop and refuses invalid ATR", () => {
    expect(atrStopForEntry(100, 2)).toBeCloseTo(94.4, 8);
    expect(atrStopForEntry(100, 0)).toBeNull();
    expect(atrStopForEntry(5, 2)).toBeNull();
  });

  it("changes only the stop on new entries; target and candidate population are shared", () => {
    const baseline = advanceAtrStopReplaySession(step({ arm: "baseline" }));
    const variant = advanceAtrStopReplaySession(step({ arm: "atr_2_8" }));
    expect(baseline.acceptedEntryIds).toEqual(variant.acceptedEntryIds);
    expect(baseline.book.positions[0]).toMatchObject({ initialStopLoss: 95, currentStop: 95, priceTarget: 110, applyAtrStop: false });
    expect(variant.book.positions[0]).toMatchObject({ initialStopLoss: 94.4, currentStop: 94.4, priceTarget: 110, applyAtrStop: true });
    expect(baseline.book.cash).toBe(variant.book.cash);
  });

  it("matches the paper RPC's pyramiding contract without resetting original exit state", () => {
    const existing = {
      symbol: "ABC", quantity: 2, costBasis: 90, initialStopLoss: 85,
      currentStop: 88, priceTarget: 110, highestPrice: 103,
      applyAtrStop: false, partialTaken: false,
    };
    const result = advanceAtrStopReplaySession(step({
      arm: "atr_2_8", book: { ...seed(), positions: [existing] },
      bars: [{ symbol: "ABC", open: 100, high: 104, low: 98, close: 101 }],
      entries: [entry({ quantity: 1, fillPrice: 100 })],
    }));
    expect(result.acceptedEntryIds).toEqual(["decision-1"]);
    expect(result.book.positions[0]).toMatchObject({
      quantity: 3, costBasis: (2 * 90 + 100) / 3,
      initialStopLoss: 85, priceTarget: 110, highestPrice: 103,
      applyAtrStop: false, partialTaken: false,
    });
    expect(result.book.positions[0].currentStop).toBeGreaterThan(88);
  });

  it("keeps legacy seed positions identical instead of inventing missing levels", () => {
    const oldPosition = {
      symbol: "OLD", quantity: 3, costBasis: 20, initialStopLoss: null,
      currentStop: null, priceTarget: null, highestPrice: 22,
      applyAtrStop: false, partialTaken: false,
    };
    const baselineBook = { ...seed(), positions: [oldPosition] };
    const variantBook = { ...seed(), positions: [oldPosition] };
    const bars = [{ symbol: "OLD", open: 21, high: 23, low: 20.5, close: 22 }];
    const baseline = advanceAtrStopReplaySession(step({ arm: "baseline", book: baselineBook, entries: [], bars }));
    const variant = advanceAtrStopReplaySession(step({ arm: "atr_2_8", book: variantBook, entries: [], bars }));
    expect(baseline.book).toEqual(variant.book);
  });

  it("round-trips all stop/target/trailing state through the existing JSONB book-state contract", () => {
    const book = {
      ...seed(),
      positions: [{
        symbol: "ABC", quantity: 2, costBasis: 100, initialStopLoss: 95,
        currentStop: 98, priceTarget: 110, highestPrice: 105,
        applyAtrStop: true, partialTaken: true,
      }],
    };
    expect(atrReplayBookFromShadowState(atrReplayBookToShadowState(book))).toEqual(book);
  });

  it("uses stop-first barrier precedence and the production paper fill contract", () => {
    const open = advanceAtrStopReplaySession(step());
    const stopWins = advanceAtrStopReplaySession(step({
      session: "2026-09-29", book: open.book, entries: [],
      bars: [{ symbol: "ABC", open: 100, high: 112, low: 94, close: 108 }],
    }));
    expect(stopWins.exits).toEqual([{ symbol: "ABC", reason: "stop", quantity: 2, fillPrice: 95, executionSource: "replay_priced" }]);

    const gapBook = { ...open.book, positions: open.book.positions.map((p) => ({ ...p, initialStopLoss: 95, currentStop: 95 })) };
    const gap = advanceAtrStopReplaySession(step({
      session: "2026-09-29", book: gapBook, entries: [],
      bars: [{ symbol: "ABC", open: 90, high: 103, low: 88, close: 100 }],
    }));
    expect(gap.exits[0].fillPrice).toBe(95);
  });

  it("matches India close-only exits instead of using unavailable intraday triggers", () => {
    const opened = advanceAtrStopReplaySession(step({
      market: "india", book: { ...seed(), market: "india" },
      entries: [entry({ baselineStopLoss: 95, priceTarget: 110 })],
    }));
    const held = advanceAtrStopReplaySession(step({
      market: "india", session: "2026-09-29", book: { ...opened.book, session: "2026-09-28" }, entries: [],
      bars: [{ symbol: "ABC", open: 100, high: 112, low: 94, close: 108 }],
    }));
    expect(held.exits).toEqual([]);
    expect(held.book.positions).toHaveLength(1);
  });

  it("rejects malformed entry-time stop/target geometry in both arms", () => {
    const bad = entry({ baselineStopLoss: 101, priceTarget: 99 });
    const baseline = advanceAtrStopReplaySession(step({ arm: "baseline", entries: [bad] }));
    const variant = advanceAtrStopReplaySession(step({ arm: "atr_2_8", entries: [bad] }));
    expect(baseline.acceptedEntryIds).toEqual([]);
    expect(variant.acceptedEntryIds).toEqual([]);
    expect(baseline.excludedEntries).toEqual(variant.excludedEntries);
  });

  it("uses the existing partial-target ladder and applies shared confirmed score exits after mechanical checks", () => {
    const opened = advanceAtrStopReplaySession(step({ entries: [entry({ priceTarget: 101 })] }));
    const partial = advanceAtrStopReplaySession(step({
      session: "2026-09-29", book: opened.book, entries: [],
      bars: [{ symbol: "ABC", open: 100, high: 102, low: 99, close: 101.5 }],
    }));
    expect(partial.exits).toHaveLength(1);
    expect(partial.exits[0]).toMatchObject({ reason: "target", quantity: 1 });
    expect(partial.book.positions[0]).toMatchObject({ quantity: 1, priceTarget: null, partialTaken: true });
    expect(partial.book.positions[0].currentStop).toBeGreaterThanOrEqual(100);

    const scoreExit = advanceAtrStopReplaySession(step({
      session: "2026-09-29", book: opened.book, entries: [],
      bars: [{ symbol: "ABC", open: 100, high: 100.8, low: 99, close: 100.5 }],
      confirmedScoreExitSymbols: ["abc"],
    }));
    expect(scoreExit.exits).toEqual([{ symbol: "ABC", reason: "score", quantity: 2, fillPrice: 100.5, executionSource: "replay_priced" }]);
  });

  it("replays common exogenous sells at their recorded fill and clamps to each arm's remaining quantity", () => {
    const position = {
      symbol: "ABC", quantity: 2, costBasis: 100, initialStopLoss: 90,
      currentStop: 90, priceTarget: 120, highestPrice: 100,
      applyAtrStop: false, partialTaken: false,
    };
    const result = advanceAtrStopReplaySession(step({
      session: "2026-09-29", book: { ...seed(), session: "2026-09-28", cash: 800, positions: [position] }, entries: [],
      bars: [{ symbol: "ABC", open: 103, high: 107, low: 102, close: 106 }],
      externalExits: [{ symbol: "ABC", quantity: 3, fillPrice: 104, filledAt: "2026-09-29T20:15:00.000Z", reason: "capital_rotation" }],
    }));
    expect(result.exits).toEqual([{ symbol: "ABC", reason: "capital_rotation", quantity: 2, fillPrice: 104, executionSource: "recorded_fill", filledAt: "2026-09-29T20:15:00.000Z" }]);
    expect(result.book.positions).toEqual([]);
    expect(result.book.cash).toBeCloseTo(800 + 2 * 104);
    expect(result.sellCost).toBe(0);
  });

  it("applies an explicit same-session sale after an entry without testing pre-entry intraday barriers", () => {
    const result = advanceAtrStopReplaySession(step({
      entries: [entry()],
      externalExits: [{ symbol: "ABC", quantity: 1, fillPrice: 110, filledAt: "2026-09-28T20:15:00.000Z", reason: "capital_rotation" }],
    }));
    expect(result.acceptedEntryIds).toEqual(["decision-1"]);
    expect(result.exits).toEqual([{ symbol: "ABC", reason: "capital_rotation", quantity: 1, fillPrice: 110, executionSource: "recorded_fill", filledAt: "2026-09-28T20:15:00.000Z" }]);
    expect(result.unmatchedExternalExits).toEqual([]);
    expect(result.book.positions[0].quantity).toBe(1);
    expect(result.book.cash).toBeCloseTo(800 + 110);
    expect(result.sellCost).toBe(0);
  });

  it("rejects same-day entry/sale order that the daily replay cannot represent", () => {
    expect(() => advanceAtrStopReplaySession(step({
      entries: [entry({ filledAt: "2026-09-28T16:00:00.000Z" })],
      externalExits: [{ symbol: "ABC", quantity: 1, fillPrice: 110, filledAt: "2026-09-28T15:30:00.000Z", reason: "capital_rotation" }],
    }))).toThrow("precedes or interleaves an entry");
  });

  it("refuses a same-session mechanical barrier plus external sale because OHLC has no ordering", () => {
    const seedBook = {
      ...seed(),
      positions: [{ symbol: "ABC", quantity: 2, costBasis: 100, initialStopLoss: 95, currentStop: 95,
        priceTarget: 110, highestPrice: 100, applyAtrStop: false, partialTaken: false }],
    };
    expect(() => advanceAtrStopReplaySession(step({
      book: seedBook, entries: [],
      bars: [{ symbol: "ABC", open: 100, high: 112, low: 94, close: 108 }],
      externalExits: [{ symbol: "ABC", quantity: 2, fillPrice: 108, filledAt: "2026-09-28T20:15:00.000Z", reason: "score" }],
    }))).toThrow("order-ambiguous");
  });

  function heldAbc() {
    const initialBook = seed();
    initialBook.positions.push({
      symbol: "ABC", quantity: 2, costBasis: 100, initialStopLoss: 90, currentStop: 95,
      priceTarget: 120, highestPrice: 110, applyAtrStop: false, partialTaken: false,
    });
    return initialBook;
  }

  it("adjusts share and barrier units for a split", () => {
    const initialBook = heldAbc();
    const result = advanceAtrStopReplaySession(step({
      entries: [], book: initialBook,
      bars: [{ symbol: "ABC", open: 51.6, high: 52, low: 51.4, close: 51.8 }],
      corporateActions: [{ symbol: "ABC", session: "2026-09-28", type: "split", splitRatio: 2 }],
    }));

    expect(result.book.positions[0]).toMatchObject({
      quantity: 4, costBasis: 50, initialStopLoss: 45, currentStop: 49.5, priceTarget: 60, highestPrice: 55,
    });
    expect(initialBook.positions[0]).toMatchObject({ quantity: 2, costBasis: 100, priceTarget: 120, highestPrice: 110 });
  });

  it("credits gross dividend entitlement on held shares", () => {
    const result = advanceAtrStopReplaySession(step({
      entries: [], book: heldAbc(),
      bars: [{ symbol: "ABC", open: 109, high: 110, low: 108, close: 109.5 }],
      corporateActions: [{ symbol: "ABC", session: "2026-09-28", type: "dividend", dividendPerShare: 1 }],
    }));
    expect(result.grossDividendCash).toBe(2);
    expect(result.book.cash).toBe(seed().cash + 2);
  });

  it("refuses a same-session split and dividend on a held symbol (per-share units are ambiguous)", () => {
    expect(() => advanceAtrStopReplaySession(step({
      entries: [], book: heldAbc(),
      bars: [{ symbol: "ABC", open: 51.6, high: 52, low: 51.4, close: 51.8 }],
      corporateActions: [
        { symbol: "ABC", session: "2026-09-28", type: "dividend", dividendPerShare: 1 },
        { symbol: "ABC", session: "2026-09-28", type: "split", splitRatio: 2 },
      ],
    }))).toThrow("ambiguous per-share units");
  });

  it("rejects malformed or wrong-session corporate actions", () => {
    expect(() => advanceAtrStopReplaySession(step({ corporateActions: [
      { symbol: "ABC", session: "2026-09-29", type: "split", splitRatio: 2 },
    ] }))).toThrow("Corporate actions must be unique, session-aligned");
  });

  it("drops an entry with unavailable decision-time ATR in both arms", () => {
    const missingAtr = entry({ atr14AtDecision: Number.NaN });
    const baseline = advanceAtrStopReplaySession(step({ arm: "baseline", entries: [missingAtr] }));
    const variant = advanceAtrStopReplaySession(step({ arm: "atr_2_8", entries: [missingAtr] }));
    expect(baseline.acceptedEntryIds).toEqual([]);
    expect(variant.acceptedEntryIds).toEqual([]);
    expect(baseline.excludedEntries).toEqual(variant.excludedEntries);
  });

  it("fails closed on missing held-name marks, duplicate bars, and market drift", () => {
    const opened = advanceAtrStopReplaySession(step());
    const heldBook = { ...opened.book, session: "2026-09-28" };
    expect(() => advanceAtrStopReplaySession(step({ session: "2026-09-29", book: heldBook, entries: [] })))
      .toThrow("lacks an OHLC bar");
    expect(() => advanceAtrStopReplaySession(step({ bars: [
      { symbol: "ABC", open: 1, high: 1, low: 1, close: 1 },
      { symbol: "ABC", open: 1, high: 1, low: 1, close: 1 },
    ] }))).toThrow("duplicate, or invalid OHLC bar");
    expect(() => advanceAtrStopReplaySession(step({ market: "india" }))).toThrow("market does not match");
  });

  it("refuses the current mixed adjusted-close/raw-range price-cache contract", () => {
    expect(() => advanceAtrStopReplaySession(step({ priceBasis: "mixed_adjusted_close_raw_ohlc" })))
      .toThrow("requires one verified raw-OHLC price basis");
  });
});
