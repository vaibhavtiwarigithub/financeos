import type { DailyMark } from "@/lib/strategy-replay/nav-marker";
import { atrStopStepToPortfolioEvents } from "@/lib/shadows/atr-stop-paired-events";
import { advanceAtrStopReplaySession, type AtrStopReplayBook, type AtrStopReplayEntry, type AtrStopReplayExternalExit, type AtrStopReplayBar, type AtrStopReplayCosts, type AtrStopReplayStepInput } from "@/lib/shadows/atr-stop-forward-replay";
import { reconcileCorporateActionsForSession, type CorporateActionCoverageRow, type CorporateActionLedgerRow } from "@/lib/shadows/corporate-action-reconcile";

export interface AtrForwardSessionInput {
  market: "us" | "india";
  session: string;
  baselineBook: AtrStopReplayBook;
  variantBook: AtrStopReplayBook;
  bars: AtrStopReplayBar[];
  benchmarkClose: number;
  yahooActions: Parameters<typeof reconcileCorporateActionsForSession>[0]["yahooActions"];
  corporateActionLedger: CorporateActionLedgerRow[];
  corporateActionCoverage: CorporateActionCoverageRow[];
  entries: AtrStopReplayEntry[];
  externalExits: AtrStopReplayExternalExit[];
  confirmedScoreExitSymbols?: string[];
  costs: AtrStopReplayCosts;
  now?: Date;
}

/** Build exactly one matched forward session; this is a source-contract adapter, not a persistence route. */
export function buildAtrForwardSession(input: AtrForwardSessionInput): {
  baselineBook: AtrStopReplayBook;
  variantBook: AtrStopReplayBook;
  mark: DailyMark;
  baselineEvents: ReturnType<typeof atrStopStepToPortfolioEvents>["events"];
  variantEvents: ReturnType<typeof atrStopStepToPortfolioEvents>["events"];
  turnoverNotional: number;
  diagnostics: { baselineExitCount: number; variantExitCount: number; entryCount: number };
} {
  if (!(input.benchmarkClose > 0) || !Number.isFinite(input.benchmarkClose)) throw new Error("ATR forward session requires a positive same-session benchmark close.");
  const symbols = [...new Set([
    ...input.baselineBook.positions.map((position) => position.symbol),
    ...input.variantBook.positions.map((position) => position.symbol),
    ...input.entries.map((entry) => entry.symbol),
    ...input.externalExits.map((exit) => exit.symbol),
  ].map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))];
  const bars = new Map<string, AtrStopReplayBar>();
  for (const bar of input.bars) {
    const key = bar.symbol.trim().toUpperCase();
    if (!key || bars.has(key) || ![bar.open, bar.high, bar.low, bar.close].every((value) => Number.isFinite(value) && value > 0)
      || bar.low > Math.min(bar.open, bar.close) || bar.high < Math.max(bar.open, bar.close) || bar.low > bar.high) {
      throw new Error(`ATR forward source has duplicate or invalid OHLC for ${bar.symbol}.`);
    }
    bars.set(key, { ...bar, symbol: key });
  }
  const missing = symbols.filter((symbol) => !bars.has(symbol));
  if (missing.length) throw new Error(`ATR forward source lacks raw OHLC for: ${missing.join(", ")}.`);

  const actionCheck = reconcileCorporateActionsForSession({
    symbols,
    session: input.session,
    yahooActions: input.yahooActions,
    ledgerRows: input.corporateActionLedger,
    coverageRows: input.corporateActionCoverage,
    now: input.now,
  });
  if (actionCheck.actions == null) throw new Error(`ATR forward corporate-action gate failed: ${actionCheck.blockers.join("; ")}`);
  const common: Omit<AtrStopReplayStepInput, "arm" | "book"> = {
    market: input.market,
    priceBasis: "raw_ohlc",
    session: input.session,
    bars: [...bars.values()],
    corporateActions: actionCheck.actions,
    entries: input.entries,
    confirmedScoreExitSymbols: input.confirmedScoreExitSymbols,
    externalExits: input.externalExits,
    costs: input.costs,
  } as const;
  const baselineStep = { ...common, arm: "baseline" as const, book: input.baselineBook };
  const variantStep = { ...common, arm: "atr_2_8" as const, book: input.variantBook };
  const baseline = advanceAtrStopReplaySession(baselineStep);
  const variant = advanceAtrStopReplaySession(variantStep);
  const baselineAdapter = atrStopStepToPortfolioEvents({ step: baselineStep, result: baseline });
  const variantAdapter = atrStopStepToPortfolioEvents({ step: variantStep, result: variant });
  const turnoverNotional = variantAdapter.events
    .reduce((sum, event) => sum + event.price * (event.quantity ?? 0), 0);

  return {
    baselineBook: baseline.book,
    variantBook: variant.book,
    mark: { session: input.session, prices: Object.fromEntries([...bars].map(([symbol, bar]) => [symbol, bar.close])), benchClose: input.benchmarkClose },
    baselineEvents: baselineAdapter.events,
    variantEvents: variantAdapter.events,
    turnoverNotional,
    diagnostics: { baselineExitCount: baseline.exits.length, variantExitCount: variant.exits.length, entryCount: input.entries.length },
  };
}
