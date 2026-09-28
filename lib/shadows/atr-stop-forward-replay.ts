import { decideExitLadder, paperStopFillPrice } from "@/lib/trading/exit-ladder";
import type { PaperQuantityMarket } from "@/lib/trading/paper-quantity";
import type { ShadowBookState } from "@/lib/shadows/shadow-book-ledger";

export const ATR_STOP_FORWARD_PROGRAM_VERSION = "atr-stop-2.8-forward-v1";
export const ATR_STOP_FORWARD_BASELINE_VERSION = "current-paper-exit-frozen-seed-v1";
export const ATR_STOP_MULTIPLE = 2.8;

export interface AtrStopReplayPosition {
  symbol: string;
  quantity: number;
  costBasis: number;
  initialStopLoss: number | null;
  currentStop: number | null;
  priceTarget: number | null;
  highestPrice: number;
  /** True only for entries made after the forward replay's frozen start. */
  applyAtrStop: boolean;
  partialTaken: boolean;
}

export interface AtrStopReplayBook {
  market: PaperQuantityMarket;
  session: string;
  cash: number;
  positions: AtrStopReplayPosition[];
}

export interface AtrStopReplayBar {
  symbol: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface AtrStopReplayCorporateAction {
  symbol: string;
  session: string;
  type: "split" | "dividend";
  /** New shares per old share; e.g. 2 for a 2:1 split. */
  splitRatio?: number;
  /** Gross cash entitlement per share held immediately before the ex-date. */
  dividendPerShare?: number;
}

export interface AtrStopReplayEntry {
  decisionId: string;
  symbol: string;
  session: string;
  filledAt: string;
  quantity: number;
  fillPrice: number;
  /** The exact initial stop passed to the production paper-fill RPC. */
  baselineStopLoss: number;
  /** The unchanged target passed to the production paper-fill RPC. */
  priceTarget: number;
  /** Absolute price ATR(14) known at decision time, not a future/recomputed ATR. */
  atr14AtDecision: number;
}

export interface AtrStopReplayExternalExit {
  symbol: string;
  quantity: number;
  /** `fillPrice` is the actual paper-ledger fill, which already includes modeled sell slippage. */
  fillPrice: number;
  filledAt: string;
  reason: "score" | "direction_flip" | "capital_rotation" | "manual";
}

export interface AtrStopReplayCosts {
  version: string;
  /** Cost applied to replay-priced mechanical/score fills; recorded external fill prices already include sell slippage. */
  sellCostBps: number;
}

export interface AtrStopReplayStepInput {
  market: PaperQuantityMarket;
  arm: "baseline" | "atr_2_8";
  /** Stop/target barriers must use executable raw OHLC, never mixed adjusted-close/raw-range cache rows. */
  priceBasis: string;
  session: string;
  book: AtrStopReplayBook;
  bars: AtrStopReplayBar[];
  /** Complete actions for the session. Dividend cash is gross; taxes are not modeled. */
  corporateActions: AtrStopReplayCorporateAction[];
  entries: AtrStopReplayEntry[];
  /** Same fresh, two-session-confirmed score exits are applied to both arms. */
  confirmedScoreExitSymbols?: string[];
  /** Same-session non-mechanical paper sells; mechanical stop/target sells are simulated by this replay instead. */
  externalExits?: AtrStopReplayExternalExit[];
  costs: AtrStopReplayCosts;
}

export interface AtrStopReplayStepResult {
  book: AtrStopReplayBook;
  acceptedEntryIds: string[];
  exits: Array<{ symbol: string; reason: "stop" | "target" | "score" | "direction_flip" | "capital_rotation" | "manual"; quantity: number; fillPrice: number; executionSource: "replay_priced" | "recorded_fill"; filledAt?: string }>;
  unmatchedExternalExits: Array<{ symbol: string; reason: "score" | "direction_flip" | "capital_rotation" | "manual"; quantity: number }>;
  sellCost: number;
  grossDividendCash: number;
  excludedEntries: Array<{ decisionId: string; reason: string }>;
}

const positive = (value: number) => Number.isFinite(value) && value > 0;

function exchangeSessionDateAt(timestamp: string, market: PaperQuantityMarket): string {
  const date = new Date(timestamp);
  if (!timestamp || !Number.isFinite(date.getTime())) throw new Error("Replay event requires a valid exact fill timestamp.");
  const zone = market === "us" ? "America/New_York" : "Asia/Kolkata";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => parts.find((value) => value.type === type)?.value;
  const year = part("year"), month = part("month"), day = part("day");
  if (!year || !month || !day) throw new Error("Replay event timestamp could not be mapped to a market session.");
  return `${year}-${month}-${day}`;
}

/** Store the full exit state inside the existing JSONB book state for resumable daily runs. */
export function atrReplayBookToShadowState(book: AtrStopReplayBook): ShadowBookState {
  return {
    market: book.market,
    session: book.session,
    cash: book.cash,
    positions: book.positions.map(({ symbol, quantity, costBasis, ...replayState }) => ({
      symbol,
      quantity,
      costBasis,
      replayState: { program: "atr-stop", ...replayState },
    })),
  };
}

/** Decode only snapshots explicitly written by this ATR replay contract. */
export function atrReplayBookFromShadowState(state: ShadowBookState): AtrStopReplayBook {
  const positions = state.positions.map((position) => {
    const replayState = position.replayState;
    if (!replayState || replayState.program !== "atr-stop"
      || typeof replayState.applyAtrStop !== "boolean" || typeof replayState.partialTaken !== "boolean"
      || typeof replayState.highestPrice !== "number" || !Number.isFinite(replayState.highestPrice)
      || !(replayState.initialStopLoss == null || typeof replayState.initialStopLoss === "number")
      || !(replayState.currentStop == null || typeof replayState.currentStop === "number")
      || !(replayState.priceTarget == null || typeof replayState.priceTarget === "number")) {
      throw new Error(`Shadow position ${position.symbol} lacks versioned ATR replay state.`);
    }
    return {
      symbol: position.symbol,
      quantity: position.quantity,
      costBasis: position.costBasis,
      initialStopLoss: replayState.initialStopLoss as number | null,
      currentStop: replayState.currentStop as number | null,
      priceTarget: replayState.priceTarget as number | null,
      highestPrice: replayState.highestPrice,
      applyAtrStop: replayState.applyAtrStop,
      partialTaken: replayState.partialTaken,
    };
  });
  return { market: state.market, session: state.session, cash: state.cash, positions };
}

/**
 * Create the shadow-arm stop for a new entry. It deliberately refuses a missing
 * or malformed ATR rather than substituting a guessed stop. The baseline and
 * target stay fixed; only the new position's stop geometry changes.
 */
export function atrStopForEntry(entryPrice: number, atr14: number): number | null {
  if (!positive(entryPrice) || !positive(atr14)) return null;
  const stop = entryPrice - ATR_STOP_MULTIPLE * atr14;
  return positive(stop) && stop < entryPrice ? stop : null;
}

function validateBook(book: AtrStopReplayBook, market: PaperQuantityMarket, session: string): void {
  if (book.market !== market) throw new Error("Replay book market does not match the session market.");
  if (book.session >= session) throw new Error("Replay step must advance to a strictly later market session.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(session)) throw new Error("Replay session must be an ISO market-session date.");
  if (!Number.isFinite(book.cash) || book.cash < 0) throw new Error("Replay cash must be finite and non-negative.");
  const symbols = new Set<string>();
  for (const position of book.positions) {
    const key = position.symbol.trim().toUpperCase();
    if (!key || symbols.has(key) || !positive(position.quantity) || !positive(position.costBasis)
      || !positive(position.highestPrice)) throw new Error("Replay positions must have unique symbols and valid quantity/basis/high-water marks.");
    symbols.add(key);
  }
}

/**
 * Advance one market session without touching the paper portfolio. Existing
 * seed positions remain identical in both arms; forward entries receive the
 * exact baseline stop or the 2.8-ATR challenger stop. Both books use the same daily bars, entry events,
 * target, partial ladder, confirmed score exits, and sell-cost model.
 */
export function advanceAtrStopReplaySession(input: AtrStopReplayStepInput): AtrStopReplayStepResult {
  validateBook(input.book, input.market, input.session);
  if (input.priceBasis !== "raw_ohlc") {
    throw new Error("ATR exit replay requires one verified raw-OHLC price basis for executable barrier checks.");
  }
  if (!input.costs.version.trim() || !Number.isFinite(input.costs.sellCostBps) || input.costs.sellCostBps < 0) {
    throw new Error("A versioned non-negative sell-cost model is required.");
  }

  const bars = new Map<string, AtrStopReplayBar>();
  for (const bar of input.bars) {
    const symbol = bar.symbol.trim().toUpperCase();
    if (!symbol || bars.has(symbol) || ![bar.open, bar.high, bar.low, bar.close].every(positive)
      || bar.low > Math.min(bar.open, bar.close) || bar.high < Math.max(bar.open, bar.close) || bar.low > bar.high) {
      throw new Error(`Missing, duplicate, or invalid OHLC bar for ${bar.symbol}.`);
    }
    bars.set(symbol, { ...bar, symbol });
  }

  const exits: AtrStopReplayStepResult["exits"] = [];
  const unmatchedExternalExits: AtrStopReplayStepResult["unmatchedExternalExits"] = [];
  const excludedEntries: AtrStopReplayStepResult["excludedEntries"] = [];
  const positions: AtrStopReplayPosition[] = [];
  let cash = input.book.cash;
  let sellCost = 0;
  let grossDividendCash = 0;
  const sellCostRate = input.costs.sellCostBps / 10_000;
  const startingPositions = input.book.positions.map((position) => ({ ...position }));
  const actionsBySymbol = new Map<string, AtrStopReplayCorporateAction[]>();
  const actionIds = new Set<string>();
  for (const action of input.corporateActions) {
    const symbol = action.symbol.trim().toUpperCase();
    const actionId = `${symbol}:${action.type}`;
    if (!symbol || action.session !== input.session || actionIds.has(actionId)
      || (action.type === "split" && (!positive(action.splitRatio ?? Number.NaN) || action.dividendPerShare != null))
      || (action.type === "dividend" && (!Number.isFinite(action.dividendPerShare) || action.dividendPerShare! < 0 || action.splitRatio != null))) {
      throw new Error("Corporate actions must be unique, session-aligned, and contain valid split or dividend terms.");
    }
    actionIds.add(actionId);
    const rows = actionsBySymbol.get(symbol) ?? [];
    rows.push(action);
    actionsBySymbol.set(symbol, rows);
  }
  for (const [symbol, actions] of actionsBySymbol) {
    const position = startingPositions.find((row) => row.symbol.toUpperCase() === symbol);
    // Providers disagree on whether a same-ex-date dividend is quoted per pre-
    // or post-split share. Guessing changes cash by the split ratio, so a held
    // symbol with both actions is blocked rather than replayed.
    if (position && actions.some((a) => a.type === "split") && actions.some((a) => a.type === "dividend")) {
      throw new Error(`Same-session split and dividend for held ${symbol} have ambiguous per-share units; replay refuses to guess.`);
    }
    for (const action of actions) {
      if (!position) continue;
      if (action.type === "split") {
        const ratio = action.splitRatio!;
        position.quantity *= ratio;
        position.costBasis /= ratio;
        position.initialStopLoss = position.initialStopLoss == null ? null : position.initialStopLoss / ratio;
        position.currentStop = position.currentStop == null ? null : position.currentStop / ratio;
        position.priceTarget = position.priceTarget == null ? null : position.priceTarget / ratio;
        position.highestPrice /= ratio;
      } else {
        const entitlement = position.quantity * action.dividendPerShare!;
        cash += entitlement;
        grossDividendCash += entitlement;
      }
    }
  }
  const scoreExits = new Set((input.confirmedScoreExitSymbols ?? []).map((symbol) => symbol.toUpperCase()));
  const externalExits = new Map<string, AtrStopReplayExternalExit[]>();
  for (const exit of input.externalExits ?? []) {
    const symbol = exit.symbol.trim().toUpperCase();
    if (!symbol || !positive(exit.quantity) || !positive(exit.fillPrice)
      || !["score", "direction_flip", "capital_rotation", "manual"].includes(exit.reason)) {
      throw new Error("External replay sells require a valid symbol, quantity, fill and classified non-mechanical reason.");
    }
    if (exchangeSessionDateAt(exit.filledAt, input.market) !== input.session) {
      throw new Error("External replay sell timestamp does not belong to its declared market session.");
    }
    const rows = externalExits.get(symbol) ?? [];
    rows.push({ ...exit, symbol });
    externalExits.set(symbol, rows);
  }

  const entriesBySymbol = new Map<string, AtrStopReplayEntry[]>();
  for (const entry of input.entries) {
    const symbol = entry.symbol.trim().toUpperCase();
    if (exchangeSessionDateAt(entry.filledAt, input.market) !== input.session || entry.session !== input.session) {
      throw new Error("Replay entry timestamp does not belong to its declared market session.");
    }
    const rows = entriesBySymbol.get(symbol) ?? [];
    rows.push(entry);
    entriesBySymbol.set(symbol, rows);
  }
  for (const [symbol, sells] of externalExits) {
    const entries = entriesBySymbol.get(symbol) ?? [];
    if (entries.length) {
      const hasSeedPosition = startingPositions.some((position) => position.symbol.toUpperCase() === symbol);
      const totalEntryQuantity = entries.reduce((sum, entry) => sum + entry.quantity, 0);
      const totalSellQuantity = sells.reduce((sum, exit) => sum + exit.quantity, 0);
      if (sells.some((sell) => entries.some((entry) => Date.parse(sell.filledAt) <= Date.parse(entry.filledAt)))) {
        throw new Error("Same-session replay sale precedes or interleaves an entry; daily replay cannot allocate the sold lot safely.");
      }
      if (!hasSeedPosition && totalSellQuantity > totalEntryQuantity + 1e-9) {
        throw new Error("Same-session replay sale exceeds the quantity of its matched entry.");
      }
    }
  }

  for (const position of startingPositions) {
    const bar = bars.get(position.symbol.toUpperCase());
    if (!bar) throw new Error(`Held symbol ${position.symbol} lacks an OHLC bar for ${input.session}.`);
    const isUs = input.market === "us";
    const decision = decideExitLadder({
      market: input.market,
      qty: position.quantity,
      avgEntry: position.costBasis,
      price: bar.close,
      // Match the live paper monitor: US has completed-session OHLC
      // corroboration; India currently evaluates exits from its close only.
      targetCheckPrice: isUs ? bar.high : bar.close,
      stopCheckPrice: isUs ? Math.min(bar.close, bar.low) : bar.close,
      priceTarget: position.priceTarget,
      initialStopLoss: position.initialStopLoss,
      currentStop: position.currentStop,
      highestPrice: position.highestPrice,
      partialTaken: position.partialTaken,
    });

    // Daily OHLC cannot tell whether a separately recorded intraday sale came
    // before or after a stop/target touch. Do not choose a favorable event
    // ordering. The caller must exclude/reconcile this session before claiming
    // a portfolio counterfactual.
    if ((externalExits.has(position.symbol.toUpperCase()) || scoreExits.has(position.symbol.toUpperCase()))
      && ["stop_full", "target_full", "partial_target"].includes(decision.action)) {
      throw new Error(`Same-session external sale and mechanical barrier are order-ambiguous for ${position.symbol}.`);
    }

    if (decision.action === "stop_full" || decision.action === "target_full") {
      const fillPrice = decision.action === "stop_full"
        // This is the paper monitor's established close/stop fill contract.
        // The replay must not invent a more pessimistic open fill that the
        // baseline implementation does not use.
        ? paperStopFillPrice(bar.close, decision.trailingStop)
        : bar.close;
      const gross = fillPrice * position.quantity;
      const cost = gross * sellCostRate;
      cash += gross - cost;
      sellCost += cost;
      exits.push({ symbol: position.symbol, reason: decision.action === "stop_full" ? "stop" : "target", quantity: position.quantity, fillPrice, executionSource: "replay_priced" });
      continue;
    }

    if (decision.action === "partial_target") {
      const quantity = decision.exitQty!;
      const fillPrice = bar.close;
      const gross = fillPrice * quantity;
      const cost = gross * sellCostRate;
      cash += gross - cost;
      sellCost += cost;
      exits.push({ symbol: position.symbol, reason: "target", quantity, fillPrice, executionSource: "replay_priced" });
      positions.push({
        ...position,
        quantity: position.quantity - quantity,
        currentStop: decision.runnerStop ?? decision.trailingStop,
        priceTarget: null,
        highestPrice: decision.highestPrice,
        partialTaken: true,
      });
      continue;
    }

    if (scoreExits.has(position.symbol.toUpperCase())) {
      const gross = bar.close * position.quantity;
      const cost = gross * sellCostRate;
      cash += gross - cost;
      sellCost += cost;
      exits.push({ symbol: position.symbol, reason: "score", quantity: position.quantity, fillPrice: bar.close, executionSource: "replay_priced" });
      continue;
    }

    positions.push({ ...position, currentStop: decision.trailingStop, highestPrice: decision.highestPrice });
  }

  const acceptedEntryIds: string[] = [];
  const eventIds = new Set<string>();
  for (const entry of [...input.entries].sort((a, b) => Date.parse(a.filledAt) - Date.parse(b.filledAt) || a.decisionId.localeCompare(b.decisionId))) {
    const symbol = entry.symbol.trim().toUpperCase();
    if (!entry.decisionId.trim() || eventIds.has(entry.decisionId)) throw new Error("Replay entries require unique decision IDs.");
    eventIds.add(entry.decisionId);
    if (entry.session !== input.session || !symbol || !positive(entry.quantity) || !positive(entry.fillPrice)
      || !positive(entry.baselineStopLoss) || !positive(entry.priceTarget)
      || entry.baselineStopLoss >= entry.fillPrice || entry.priceTarget <= entry.fillPrice) {
      excludedEntries.push({ decisionId: entry.decisionId, reason: "entry_contract_incomplete" });
      continue;
    }
    const candidateStop = atrStopForEntry(entry.fillPrice, entry.atr14AtDecision);
    if (candidateStop == null) {
      excludedEntries.push({ decisionId: entry.decisionId, reason: "decision_time_atr_unavailable_or_invalid" });
      continue;
    }

    const notional = entry.quantity * entry.fillPrice;
    if (notional > cash + 1e-8) {
      excludedEntries.push({ decisionId: entry.decisionId, reason: "insufficient_arm_cash" });
      continue;
    }
    cash -= notional;
    const existing = positions.find((position) => position.symbol.toUpperCase() === symbol);
    if (existing) {
      // execute_paper_fill pyramids into the one aggregated paper_positions
      // row, changing quantity and weighted average only. It does not reset
      // the original stops/target or high-water mark; mirror that contract.
      const totalQuantity = existing.quantity + entry.quantity;
      existing.costBasis = (existing.costBasis * existing.quantity + notional) / totalQuantity;
      existing.quantity = totalQuantity;
    } else {
      const initialStopLoss = input.arm === "atr_2_8" ? candidateStop : entry.baselineStopLoss;
      positions.push({
        symbol,
        quantity: entry.quantity,
        costBasis: entry.fillPrice,
        initialStopLoss,
        currentStop: initialStopLoss,
        priceTarget: entry.priceTarget,
        highestPrice: entry.fillPrice,
        applyAtrStop: input.arm === "atr_2_8",
        partialTaken: false,
      });
    }
    acceptedEntryIds.push(entry.decisionId);
  }

  // Apply actual non-mechanical paper sells after same-session entry fills.
  // A new fill is not tested against that day's high/low (which may have
  // occurred before the buy), but an explicit same-session sell still applies.
  for (const [symbol, forcedSells] of externalExits) {
    forcedSells.sort((a, b) => Date.parse(a.filledAt) - Date.parse(b.filledAt));
    const positionIndex = positions.findIndex((position) => position.symbol.toUpperCase() === symbol);
    let remainingQty = positionIndex < 0 ? 0 : positions[positionIndex].quantity;
    for (const forcedSell of forcedSells) {
      const quantity = Math.min(remainingQty, forcedSell.quantity);
      if (!(quantity > 0)) {
        unmatchedExternalExits.push({ symbol, reason: forcedSell.reason, quantity: forcedSell.quantity });
        continue;
      }
      const gross = forcedSell.fillPrice * quantity;
      // External exits come from immutable paper-lot fills. PositionMonitor
      // and paper rotation have already applied modeled sell slippage to that
      // price; charging the replay sell-cost rate again double-counts it.
      const cost = 0;
      cash += gross - cost;
      sellCost += cost;
      remainingQty -= quantity;
      exits.push({ symbol, reason: forcedSell.reason, quantity, fillPrice: forcedSell.fillPrice, executionSource: "recorded_fill", filledAt: forcedSell.filledAt });
      if (quantity + 1e-9 < forcedSell.quantity) {
        unmatchedExternalExits.push({ symbol, reason: forcedSell.reason, quantity: forcedSell.quantity - quantity });
      }
      if (remainingQty <= 1e-9) break;
    }
    if (positionIndex >= 0) {
      if (remainingQty <= 1e-9) positions.splice(positionIndex, 1);
      else positions[positionIndex].quantity = remainingQty;
    }
  }

  return {
    book: { market: input.market, session: input.session, cash, positions },
    acceptedEntryIds,
    exits,
    unmatchedExternalExits,
    sellCost,
    grossDividendCash,
    excludedEntries,
  };
}
