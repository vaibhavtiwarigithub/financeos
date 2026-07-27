import { isEtfSymbol } from "@/lib/asset-classification";

export type PaperPositionExposureInput = {
  symbol?: string | null;
  qty?: number | string | null;
  current_price?: number | string | null;
  avg_cost?: number | string | null;
};

export type InternationalExposureRow = {
  symbol: string;
  geography: string;
  value: number;
  bookPct: number;
  valuation: "mark" | "cost";
};

export type InternationalExposureSummary = {
  investedValue: number;
  recognizedInternationalValue: number;
  recognizedInternationalPct: number | null;
  rows: InternationalExposureRow[];
  unclassifiedEtfSymbols: string[];
  costValuedSymbols: string[];
};

// P0/P1 has no runtime fund-data provider or country holdings look-through. This
// map is deliberately narrow: only a reviewed broad-core or curated country ETF
// gets a geographic label. Unknown or broad/global ETFs stay unavailable rather
// than being silently estimated.
const COUNTRY_ETF_GEOGRAPHY: Readonly<Record<string, string>> = {
  VXUS: "Broad ex-US",
  INDA: "India",
  EPI: "India",
  INDY: "India",
  EUAD: "Europe",
  FEZ: "Eurozone",
  VGK: "Europe",
  EWG: "Germany",
  EWL: "Switzerland",
  EWU: "United Kingdom",
  EWQ: "France",
  DXJ: "Japan",
  EWJ: "Japan",
  EWT: "Taiwan",
  EWY: "South Korea",
  EWH: "Hong Kong",
  FXI: "China",
  ASHR: "China A-shares",
  EMXC: "Emerging markets ex China",
};

function finitePositive(value: unknown): number | null {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : null;
}

/**
 * P0 portfolio read: computes only currently held US-paper position values.
 * It does not fetch prices, write the registry, infer a company's geography,
 * select a fund, or generate an allocation action.
 */
export function summarizeInternationalExposure(
  positions: readonly PaperPositionExposureInput[],
): InternationalExposureSummary {
  const valued = positions.flatMap((position) => {
    const symbol = position.symbol?.trim().toUpperCase();
    const qty = finitePositive(position.qty);
    const markedPrice = finitePositive(position.current_price);
    const cost = finitePositive(position.avg_cost);
    const price = markedPrice ?? cost;
    if (!symbol || !qty || !price) return [];
    return [{ symbol, value: qty * price, valuation: markedPrice ? "mark" as const : "cost" as const }];
  });

  const investedValue = valued.reduce((total, position) => total + position.value, 0);
  const unclassifiedEtfSymbols = new Set<string>();
  const costValuedSymbols = new Set<string>();
  const rows = valued.flatMap((position) => {
    if (position.valuation === "cost") costValuedSymbols.add(position.symbol);
    const geography = COUNTRY_ETF_GEOGRAPHY[position.symbol];
    if (!geography) {
      if (isEtfSymbol(position.symbol)) unclassifiedEtfSymbols.add(position.symbol);
      return [];
    }
    return [{
      symbol: position.symbol,
      geography,
      value: position.value,
      bookPct: investedValue > 0 ? (position.value / investedValue) * 100 : 0,
      valuation: position.valuation,
    }];
  });

  const recognizedInternationalValue = rows.reduce((total, row) => total + row.value, 0);
  return {
    investedValue,
    recognizedInternationalValue,
    recognizedInternationalPct: investedValue > 0 ? (recognizedInternationalValue / investedValue) * 100 : null,
    rows: rows.sort((a, b) => b.value - a.value || a.symbol.localeCompare(b.symbol)),
    unclassifiedEtfSymbols: [...unclassifiedEtfSymbols].sort(),
    costValuedSymbols: [...costValuedSymbols].sort(),
  };
}
