import type { YahooRawReplaySeries } from "@/lib/data/yahoo-candles";
import { buildAtrForwardSession } from "@/lib/shadows/atr-forward-session";
import { buildAtrReplaySeed, type AtrReplaySeedLotRow, type AtrReplaySeedPositionRow } from "@/lib/shadows/atr-replay-seed";
import { ATR_FORWARD_SELL_COST_BPS, booksFromLast, buildSeedSnapshotInput, buildStepSnapshotInput, historyFromRows } from "@/lib/shadows/atr-forward-collector";
import { atrReplayBookToShadowState, type AtrStopReplayBar } from "@/lib/shadows/atr-stop-forward-replay";
import { ATR_STOP_REPLAY_COST_MODEL_VERSION } from "@/lib/shadows/atr-stop-paired-replay";
import type { CorporateActionCoverageRow, CorporateActionLedgerRow } from "@/lib/shadows/corporate-action-reconcile";
import { paperLotReplayEvents, type PaperLotReplayRow } from "@/lib/shadows/paper-lot-replay-events";
import { buildShadowBookSnapshot, type ShadowBookSnapshotRow } from "@/lib/shadows/shadow-book-ledger";

export const MAX_SESSIONS_PER_RUN = 5;

export interface AtrForwardSeedSource {
  cashBalance: number | string | null;
  reportedNav: number | string | null;
  /** When the paper book's marks were last written; must be on/after the seed session. */
  marksUpdatedAt: string | null;
  /** Marks the paper NAV used, keyed by symbol (paper_position_marks for the seed session). */
  paperMarks: Record<string, number>;
  /** Session those marks belong to; must equal the seed session. */
  paperMarksSession: string | null;
  positions: AtrReplaySeedPositionRow[];
  openLots: AtrReplaySeedLotRow[];
}

export interface AtrForwardDeps {
  market: "us";
  now: Date;
  expectedLatestSession: () => string | null;
  sessionsBetween: (afterExclusive: string, throughInclusive: string) => string[];
  loadPriorRows: () => Promise<ShadowBookSnapshotRow[]>;
  loadSeedSource: () => Promise<AtrForwardSeedSource>;
  benchmarkSymbol: string;
  loadRawSeries: (symbols: string[]) => Promise<Map<string, YahooRawReplaySeries | null>>;
  loadLotRows: (afterSession: string) => Promise<PaperLotReplayRow[]>;
  loadAtrBySignal: (signalIds: string[]) => Promise<Record<string, number | null>>;
  loadActionLedger: (symbols: string[], fromSession: string, throughSession: string) => Promise<CorporateActionLedgerRow[]>;
  loadCoverage: (symbols: string[]) => Promise<CorporateActionCoverageRow[]>;
  writeSnapshot: (row: ShadowBookSnapshotRow) => Promise<"inserted" | "already_present">;
}

export interface AtrForwardRunResult {
  status: "collected" | "blocked";
  blockers: string[];
  expectedSession: string | null;
  observedSession: string | null;
  written: string[];
  details: Record<string, unknown>;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function blocked(expected: string | null, observed: string | null, written: string[], reason: string, details: Record<string, unknown> = {}): AtrForwardRunResult {
  return { status: "blocked", blockers: [reason], expectedSession: expected, observedSession: observed, written, details };
}

function candleOn(series: YahooRawReplaySeries | null | undefined, session: string) {
  return series?.candles.find((candle) => candle.date === session) ?? null;
}

/**
 * Advance the forward ATR shadow book. Data-gate failures (missing raw bars,
 * unreconciled corporate actions, unmatched sales, unreconciled seed) return a
 * blocked result and never a snapshot; already-written sessions are kept.
 * Loader failures are not caught: they are infrastructure errors, not evidence.
 */
export async function runAtrForwardCollection(deps: AtrForwardDeps): Promise<AtrForwardRunResult> {
  const expected = deps.expectedLatestSession();
  if (!expected) return blocked(null, null, [], "Market calendar cannot name the latest completed US session.");

  const prior = await deps.loadPriorRows();
  const written: string[] = [];

  if (!prior.length) {
    const source = await deps.loadSeedSource();
    if (!source.marksUpdatedAt || source.marksUpdatedAt.slice(0, 10) < expected) {
      return blocked(expected, null, written, `Paper book marks were last written ${source.marksUpdatedAt ?? "never"}, before session ${expected}; seed refused until they are refreshed.`);
    }
    if (source.paperMarksSession !== expected) {
      return blocked(expected, null, written, `Recorded paper NAV marks are for ${source.paperMarksSession ?? "no session"}, not ${expected}; seed refused.`);
    }
    const series = await deps.loadRawSeries([deps.benchmarkSymbol, ...source.positions.map((position) => position.symbol)]);
    const benchmark = candleOn(series.get(deps.benchmarkSymbol), expected);
    if (!benchmark) return blocked(expected, null, written, `No raw ${deps.benchmarkSymbol} benchmark close for ${expected}.`);
    try {
      // Shadow marks are official raw closes, the same basis every later step
      // uses; the paper NAV's own marks are used only to reconcile composition.
      const positions = source.positions.map((position) => {
        const close = candleOn(series.get(position.symbol.toUpperCase()), expected)?.close;
        if (close == null) throw new Error(`No raw close for ${position.symbol} on ${expected}.`);
        return { ...position, current_price: close };
      });
      const seed = buildAtrReplaySeed({
        market: deps.market, session: expected, cashBalance: source.cashBalance, reportedNav: source.reportedNav,
        paperMarks: source.paperMarks, positions, openLots: source.openLots,
      });
      if (!seed.book.positions.length) return blocked(expected, null, written, "No open US paper positions to seed a matched population.");
      const row = buildShadowBookSnapshot(buildSeedSnapshotInput({ market: deps.market, session: expected, seed, benchmarkClose: benchmark.close }));
      await deps.writeSnapshot(row);
      written.push(expected);
      return { status: "collected", blockers: [], expectedSession: expected, observedSession: expected, written, details: { mode: "seed", positionCount: seed.book.positions.length } };
    } catch (error) {
      return blocked(expected, null, written, `Seed refused: ${message(error)}`);
    }
  }

  let history;
  try {
    history = historyFromRows(prior);
  } catch (error) {
    return blocked(expected, null, written, `Prior history is not resumable: ${message(error)}`);
  }
  const lastSession = history.last.session_date;
  if (lastSession >= expected) {
    return { status: "collected", blockers: [], expectedSession: expected, observedSession: lastSession, written, details: { mode: "current", note: "Shadow book already at the latest completed session." } };
  }

  let sessions: string[];
  try {
    sessions = deps.sessionsBetween(lastSession, expected);
  } catch (error) {
    return blocked(expected, lastSession, written, `Session window cannot be certified: ${message(error)}`);
  }
  const todo = sessions.slice(0, MAX_SESSIONS_PER_RUN);

  let books = booksFromLast(history);
  const carriedSymbols = new Set<string>([...books.baseline.positions, ...books.variant.positions].map((p) => p.symbol.toUpperCase()));
  const lots = await deps.loadLotRows(lastSession);
  const roleFiltered = lots.filter((row) => !row.position_role || row.position_role === "alpha");
  const candidateSymbols = new Set<string>([...carriedSymbols, ...roleFiltered.map((row) => row.symbol.toUpperCase())]);
  const seriesMap = await deps.loadRawSeries([...candidateSymbols, deps.benchmarkSymbol]);
  const signalIds = [...new Set(roleFiltered.map((row) => row.signal_id).filter((id): id is string => Boolean(id)))];
  const atrBySignal = signalIds.length ? await deps.loadAtrBySignal(signalIds) : {};
  const ledger = await deps.loadActionLedger([...candidateSymbols], lastSession, todo[todo.length - 1]);
  const coverage = await deps.loadCoverage([...candidateSymbols]);

  let priorSession = lastSession;
  let currentHistory = history;
  const allRows: ShadowBookSnapshotRow[] = [...prior];
  for (const session of todo) {
    try {
      const events = paperLotReplayEvents({ market: deps.market, rows: roleFiltered, afterSession: priorSession, throughSession: session, atr14BySignalId: atrBySignal });
      const externalExits = events.exits.filter((exit) => exit.classification === "external")
        .map(({ symbol, quantity, fillPrice, filledAt, reason }) => ({ symbol, quantity, fillPrice, filledAt, reason: reason as "score" | "direction_flip" | "capital_rotation" | "manual" }));
      const symbols = new Set<string>([
        ...books.baseline.positions.map((p) => p.symbol.toUpperCase()),
        ...books.variant.positions.map((p) => p.symbol.toUpperCase()),
        ...events.entries.map((entry) => entry.symbol.toUpperCase()),
        ...externalExits.map((exit) => exit.symbol.toUpperCase()),
      ]);
      const bars: AtrStopReplayBar[] = [];
      for (const symbol of symbols) {
        const series = seriesMap.get(symbol);
        if (!series) throw new Error(`No raw OHLC series could be fetched for ${symbol}.`);
        const candle = candleOn(series, session);
        if (!candle) throw new Error(`Raw series for ${symbol} has no bar for ${session}.`);
        bars.push({ symbol, open: candle.open, high: candle.high, low: candle.low, close: candle.close });
      }
      const benchmark = candleOn(seriesMap.get(deps.benchmarkSymbol), session);
      if (!benchmark) throw new Error(`No raw ${deps.benchmarkSymbol} benchmark close for ${session}.`);

      const step = buildAtrForwardSession({
        market: deps.market, session, baselineBook: books.baseline, variantBook: books.variant, bars, benchmarkClose: benchmark.close,
        yahooActions: [...symbols].flatMap((symbol) => seriesMap.get(symbol)?.corporateActions ?? []),
        corporateActionLedger: ledger, corporateActionCoverage: coverage,
        entries: events.entries, externalExits,
        costs: { version: ATR_STOP_REPLAY_COST_MODEL_VERSION, sellCostBps: ATR_FORWARD_SELL_COST_BPS },
        now: deps.now,
      });
      const sessionsAfterSeed = deps.sessionsBetween(currentHistory.seed.window_start, session);
      const row = buildShadowBookSnapshot(buildStepSnapshotInput({
        history: currentHistory, market: deps.market, session, sessionsAfterSeed,
        baselineState: atrReplayBookToShadowState(step.baselineBook), variantState: atrReplayBookToShadowState(step.variantBook),
        mark: { prices: step.mark.prices, benchmarkClose: benchmark.close }, turnoverNotional: step.turnoverNotional, newDecisionIds: events.entries.map((entry) => entry.decisionId),
      }));
      await deps.writeSnapshot(row);
      written.push(session);
      books = { baseline: step.baselineBook, variant: step.variantBook };
      allRows.push(row);
      currentHistory = historyFromRows(allRows);
      priorSession = session;
    } catch (error) {
      return blocked(expected, priorSession, written, `Session ${session} refused: ${message(error)}`, { mode: "step", failedSession: session });
    }
  }

  const remaining = sessions.length - todo.length;
  return {
    status: "collected", blockers: [], expectedSession: expected, observedSession: priorSession, written,
    details: { mode: "step", advanced: written.length, sessionsRemaining: remaining },
  };
}
