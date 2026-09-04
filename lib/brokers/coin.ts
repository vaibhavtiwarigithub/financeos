export interface CoinHolding {
  isin: string;
  fund: string;
  folio: string | null;
  quantity: number;
  averageNav: number | null;
  latestNav: number | null;
  latestNavDate: string | null;
  investedValue: number | null;
  currentValue: number | null;
  pnl: number | null;
  pnlPct: number | null;
}

export interface CoinPortfolio {
  holdings: CoinHolding[];
  holdingCount: number;
  valuationComplete: boolean;
  totalInvested: number | null;
  totalValue: number | null;
  totalPnl: number | null;
}

function finiteNonNegative(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function finitePositive(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function normalizeCoinHolding(raw: unknown): CoinHolding | null {
  const row = (raw ?? {}) as Record<string, unknown>;
  const isin = String(row.tradingsymbol ?? "").trim().toUpperCase();
  const fund = String(row.fund ?? "").trim();
  const quantity = finitePositive(row.quantity);
  if (!isin || !fund || quantity == null) return null;

  const averageNav = finiteNonNegative(row.average_price);
  const latestNav = finiteNonNegative(row.last_price);
  const investedValue = averageNav == null ? null : averageNav * quantity;
  const currentValue = latestNav == null ? null : latestNav * quantity;
  const pnl = investedValue == null || currentValue == null ? null : currentValue - investedValue;
  const pnlPct = pnl == null || investedValue == null || investedValue <= 0
    ? null
    : (pnl / investedValue) * 100;

  const rawDate = String(row.last_price_date ?? "").trim();
  return {
    isin,
    fund,
    folio: row.folio == null || String(row.folio).trim() === "" ? null : String(row.folio).trim(),
    quantity,
    averageNav,
    latestNav,
    latestNavDate: rawDate || null,
    investedValue,
    currentValue,
    pnl,
    pnlPct,
  };
}

export function buildCoinPortfolio(raw: unknown): CoinPortfolio {
  const rows = Array.isArray(raw) ? raw : [];
  const holdings = rows.map(normalizeCoinHolding).filter((row): row is CoinHolding => row != null);
  const valuationComplete = holdings.every(row => row.investedValue != null && row.currentValue != null);

  return {
    holdings,
    holdingCount: holdings.length,
    valuationComplete,
    totalInvested: valuationComplete
      ? holdings.reduce((sum, row) => sum + row.investedValue!, 0)
      : null,
    totalValue: valuationComplete
      ? holdings.reduce((sum, row) => sum + row.currentValue!, 0)
      : null,
    totalPnl: valuationComplete
      ? holdings.reduce((sum, row) => sum + row.pnl!, 0)
      : null,
  };
}
