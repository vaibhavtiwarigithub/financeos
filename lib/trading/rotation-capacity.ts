import { constructPortfolio, type BookPosition, type PortfolioLimits } from "@/lib/portfolio/constructor";
import { paperEntryQuantity } from "./paper-quantity";

/** Reuse entry sizing on each hypothetical replacement; never enlarge a request. */
export function replacementCapacity(args: {
  book: BookPosition[]; sourceSymbol: string; sellNotional: number;
  symbol: string; market: "us" | "india"; sector: string | null; dailyVol: number | null;
  intendedNotional: number; nav: number; cash: number; fillPrice: number;
  limits: PortfolioLimits; maxPerSector: number;
}): { buyNotional: number; reason: string | null; adjustments?: string[] } {
  const { nav, cash, sellNotional, fillPrice, intendedNotional } = args;
  if (![nav, sellNotional, fillPrice, intendedNotional].every(n => Number.isFinite(n) && n > 0)
    || !Number.isFinite(cash) || cash < 0) return { buyNotional: 0, reason: "invalid_swap_sizing" };
  const remaining = args.book.filter(p => p.symbol.toUpperCase() !== args.sourceSymbol.toUpperCase());
  if (remaining.length === args.book.length) return { buyNotional: 0, reason: "source_missing_from_constructor_book" };
  if (args.sector && remaining.filter(p => p.sector === args.sector).length >= args.maxPerSector) {
    return { buyNotional: 0, reason: "post_swap_sector_count_cap" };
  }
  const requested = Math.min(intendedNotional, cash + sellNotional * 0.9995);
  const sized = constructPortfolio(remaining, [{
    symbol: args.symbol, market: args.market, sector: args.sector, dailyVol: args.dailyVol,
    beta: null, proposedSizePct: requested / nav * 100,
  }], args.limits).orders[0];
  const quantity = paperEntryQuantity(args.market, nav * (sized?.finalSizePct ?? 0) / 100, fillPrice);
  if (quantity == null || quantity * fillPrice / nav * 100 < 0.5) return { buyNotional: 0, reason: "post_swap_no_viable_allocation" };
  return { buyNotional: quantity * fillPrice, reason: null, adjustments: sized?.adjustments ?? [] };
}
