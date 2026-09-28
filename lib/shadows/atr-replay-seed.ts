import type { AtrStopReplayBook, AtrStopReplayPosition } from "@/lib/shadows/atr-stop-forward-replay";

type NumericLike = number | string | null | undefined;

export interface AtrReplaySeedPositionRow {
  symbol: string;
  market: string;
  position_role?: string | null;
  qty: NumericLike;
  avg_cost: NumericLike;
  current_price: NumericLike;
  stop_loss?: NumericLike;
  initial_stop_loss?: NumericLike;
  price_target?: NumericLike;
  highest_price?: NumericLike;
}

export interface AtrReplaySeedLotRow {
  symbol: string;
  market: string;
  position_role?: string | null;
  qty: NumericLike;
  order_side: string;
  closed_at?: string | null;
  partial_exit_lot?: boolean | null;
}

export interface AtrReplaySeedResult {
  book: AtrStopReplayBook;
  prices: Record<string, number>;
  nav: number;
  partialStateBySymbol: Record<string, boolean>;
}

function positive(value: NumericLike): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function key(symbol: string, role?: string | null): string {
  return `${symbol.trim().toUpperCase()}|${(role || "alpha").trim().toLowerCase()}`;
}

/**
 * Build an identical two-arm ATR replay seed from one reconciled market book.
 * A residual open paper lot is explicit evidence that the live paper position
 * has already taken a partial exit, so the seed preserves that ladder state.
 */
export function buildAtrReplaySeed(input: {
  market: "us" | "india";
  session: string;
  cashBalance: NumericLike;
  reportedNav: NumericLike;
  positions: AtrReplaySeedPositionRow[];
  openLots: AtrReplaySeedLotRow[];
  navTolerance?: number;
}): AtrReplaySeedResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.session)) throw new Error("ATR seed requires an explicit market session.");
  const cash = input.cashBalance == null || input.cashBalance === "" ? Number.NaN : Number(input.cashBalance);
  const reportedNav = input.reportedNav == null || input.reportedNav === "" ? Number.NaN : Number(input.reportedNav);
  if (!Number.isFinite(cash) || cash < 0 || !Number.isFinite(reportedNav) || reportedNav <= 0) {
    throw new Error("Paper cash and reported NAV must be finite and valid.");
  }

  const positionQty = new Map<string, number>();
  const identityBySymbol = new Map<string, string>();
  const positions: AtrStopReplayPosition[] = [];
  const prices: Record<string, number> = {};
  let markedPositions = 0;
  for (const row of input.positions) {
    if (row.market !== input.market) throw new Error(`Position ${row.symbol} belongs to ${row.market}, not ${input.market}.`);
    const symbol = row.symbol.trim().toUpperCase();
    const quantity = positive(row.qty);
    const costBasis = positive(row.avg_cost);
    const currentPrice = positive(row.current_price);
    if (!symbol || !quantity || !costBasis || !currentPrice) throw new Error(`Position ${row.symbol} lacks valid quantity, basis or current mark.`);
    const identity = key(symbol, row.position_role);
    if (positionQty.has(identity)) throw new Error(`Duplicate aggregate position for ${identity}; seed requires one canonical position per role.`);
    positionQty.set(identity, quantity);
    // The replay currently addresses barriers by symbol, so separate roles on
    // one ticker cannot be represented without an explicit portfolio key.
    if (prices[symbol] != null) throw new Error(`Multiple position roles for ${symbol} cannot be represented by the current replay engine.`);
    prices[symbol] = currentPrice;
    identityBySymbol.set(symbol, identity);
    markedPositions += quantity * currentPrice;
    const stop = positive(row.stop_loss);
    const initialStop = positive(row.initial_stop_loss);
    const target = positive(row.price_target);
    const high = positive(row.highest_price);
    if (high == null || high + 1e-8 < currentPrice) {
      throw new Error(`Position ${symbol} lacks a valid high-water mark at or above its current mark.`);
    }
    positions.push({
      symbol, quantity, costBasis,
      initialStopLoss: initialStop,
      currentStop: stop,
      priceTarget: target,
      highestPrice: high,
      applyAtrStop: false,
      partialTaken: false,
    });
  }

  const openLotQty = new Map<string, number>();
  const partialByKey = new Map<string, boolean>();
  for (const lot of input.openLots) {
    if (lot.market !== input.market || String(lot.order_side).toLowerCase() !== "buy" || lot.closed_at != null) {
      throw new Error(`Seed lot ${lot.symbol} is not an open long lot in ${input.market}.`);
    }
    const quantity = positive(lot.qty);
    if (!quantity) throw new Error(`Open seed lot ${lot.symbol} has invalid quantity.`);
    const identity = key(lot.symbol, lot.position_role);
    openLotQty.set(identity, (openLotQty.get(identity) ?? 0) + quantity);
    partialByKey.set(identity, (partialByKey.get(identity) ?? false) || lot.partial_exit_lot === true);
  }

  for (const [identity, quantity] of positionQty) {
    const lotQuantity = openLotQty.get(identity);
    if (lotQuantity == null || Math.abs(lotQuantity - quantity) > Math.max(1e-8, quantity * 1e-8)) {
      throw new Error(`Open paper-lot quantity does not reconcile to position ${identity}: position=${quantity}, lots=${lotQuantity ?? 0}.`);
    }
  }
  for (const [identity, quantity] of openLotQty) {
    if (!positionQty.has(identity)) throw new Error(`Open paper lots for ${identity} have no matching aggregate position (qty=${quantity}).`);
  }

  for (const position of positions) {
    const identity = identityBySymbol.get(position.symbol)!;
    position.partialTaken = partialByKey.get(identity) ?? false;
  }
  const nav = cash + markedPositions;
  const tolerance = input.navTolerance ?? Math.max(0.01, reportedNav * 1e-6);
  if (Math.abs(nav - reportedNav) > tolerance) {
    throw new Error(`Cash plus marked positions does not reconcile to paper NAV: computed=${nav}, reported=${reportedNav}, tolerance=${tolerance}.`);
  }
  const book: AtrStopReplayBook = { market: input.market, session: input.session, cash, positions };
  return {
    book,
    prices,
    nav,
    partialStateBySymbol: Object.fromEntries(positions.map((position) => [position.symbol, position.partialTaken])),
  };
}
