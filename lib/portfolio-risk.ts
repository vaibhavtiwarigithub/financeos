import type { BrokerHolding } from "./brokers/types";

// ── Sector reference data ────────────────────────────────────────────────────

const SECTOR_MAP: Record<string, string> = {
  // Technology
  AAPL:"Technology", MSFT:"Technology", NVDA:"Technology", AVGO:"Technology",
  ORCL:"Technology", CRM:"Technology", AMD:"Technology", INTC:"Technology",
  QCOM:"Technology", TXN:"Technology", NOW:"Technology", AMAT:"Technology",
  MU:"Technology", LRCX:"Technology", KLAC:"Technology", ADI:"Technology",
  MRVL:"Technology", SNPS:"Technology", CDNS:"Technology", FTNT:"Technology",
  PANW:"Technology", CRWD:"Technology", SMCI:"Technology", TSM:"Technology",
  ASML:"Technology", ARM:"Technology", PLTR:"Technology", APP:"Technology",

  // Communication Services
  GOOGL:"Communication", GOOG:"Communication", META:"Communication",
  NFLX:"Communication", DIS:"Communication", CMCSA:"Communication",
  VZ:"Communication", T:"Communication", TMUS:"Communication",

  // Consumer Discretionary
  AMZN:"Consumer Discretionary", TSLA:"Consumer Discretionary",
  HD:"Consumer Discretionary", MCD:"Consumer Discretionary",
  NKE:"Consumer Discretionary", SBUX:"Consumer Discretionary",
  TJX:"Consumer Discretionary", BKNG:"Consumer Discretionary",
  ABNB:"Consumer Discretionary", UBER:"Consumer Discretionary",

  // Financials
  BRK_B:"Financials", JPM:"Financials", V:"Financials", MA:"Financials",
  BAC:"Financials", WFC:"Financials", GS:"Financials", MS:"Financials",
  AXP:"Financials", SPGI:"Financials", BLK:"Financials", CB:"Financials",
  C:"Financials", USB:"Financials", PNC:"Financials", PYPL:"Financials",

  // Healthcare
  LLY:"Healthcare", UNH:"Healthcare", JNJ:"Healthcare", ABBV:"Healthcare",
  MRK:"Healthcare", TMO:"Healthcare", ABT:"Healthcare", DHR:"Healthcare",
  PFE:"Healthcare", AMGN:"Healthcare", ISRG:"Healthcare", GILD:"Healthcare",
  CVS:"Healthcare", BMY:"Healthcare", REGN:"Healthcare", VRTX:"Healthcare",

  // Industrials
  GE:"Industrials", CAT:"Industrials", RTX:"Industrials", HON:"Industrials",
  UPS:"Industrials", LMT:"Industrials", DE:"Industrials", BA:"Industrials",
  MMM:"Industrials", GD:"Industrials", FDX:"Industrials", NSC:"Industrials",

  // Energy
  XOM:"Energy", CVX:"Energy", COP:"Energy", EOG:"Energy", SLB:"Energy",
  MPC:"Energy", PSX:"Energy", VLO:"Energy", OXY:"Energy", PXD:"Energy",

  // Consumer Staples
  WMT:"Consumer Staples", PG:"Consumer Staples", KO:"Consumer Staples",
  PEP:"Consumer Staples", COST:"Consumer Staples", PM:"Consumer Staples",
  MO:"Consumer Staples", CL:"Consumer Staples", KHC:"Consumer Staples",

  // Utilities
  NEE:"Utilities", SO:"Utilities", DUK:"Utilities", AEP:"Utilities",
  D:"Utilities", EXC:"Utilities",

  // Real Estate
  PLD:"Real Estate", AMT:"Real Estate", EQIX:"Real Estate", SPG:"Real Estate",

  // Materials
  LIN:"Materials", APD:"Materials", SHW:"Materials", FCX:"Materials", NEM:"Materials",
};

// S&P 500 sector weights (approximate, mid-2025)
const SP500_SECTOR_WEIGHTS: Record<string, number> = {
  "Technology": 0.31, "Communication": 0.09, "Consumer Discretionary": 0.10,
  "Financials": 0.13, "Healthcare": 0.12, "Industrials": 0.09,
  "Energy": 0.04, "Consumer Staples": 0.06, "Materials": 0.02,
  "Utilities": 0.02, "Real Estate": 0.02,
};

// Sector beta approximations (vs SPY)
const SECTOR_BETA: Record<string, number> = {
  "Technology": 1.35, "Communication": 1.20, "Consumer Discretionary": 1.15,
  "Financials": 1.10, "Industrials": 1.00, "Materials": 1.00,
  "Energy": 0.95, "Real Estate": 0.85, "Healthcare": 0.80,
  "Consumer Staples": 0.60, "Utilities": 0.50, "Other": 1.0,
};

// Known highly-correlated pairs (from historical data)
const KNOWN_CORR: Record<string, Record<string, number>> = {
  NVDA: { AMD: 0.87, SMCI: 0.82, TSM: 0.76, AVGO: 0.74 },
  AAPL: { MSFT: 0.71, GOOGL: 0.65 },
  META: { GOOGL: 0.78, NFLX: 0.65 },
  AMZN: { GOOGL: 0.72, META: 0.69 },
  TSLA: { NVDA: 0.62, AMD: 0.58 },
};

// ── Types ────────────────────────────────────────────────────────────────────

export interface HoldingWithRisk extends BrokerHolding {
  sector: string;
  beta: number;
  weightPct: number;
  riskContribution: number; // % of total portfolio risk this position adds
}

export interface SectorBreakdown {
  sector: string;
  weightPct: number;
  sp500WeightPct: number;
  overweightPct: number; // positive = overweight vs S&P
  holdingCount: number;
}

export interface CorrelatedPair {
  symbol1: string;
  symbol2: string;
  correlation: number;
  severity: "high" | "medium"; // high ≥ 0.80, medium ≥ 0.65
}

export interface RiskWarning {
  type: "concentration" | "sector" | "correlation" | "beta" | "no_diversification";
  severity: "critical" | "warn" | "info";
  message: string;
  action?: string;
}

export interface RiskMetrics {
  market: "us" | "india";
  currency: string;             // "$" | "₹" — never mix these across a payload
  benchmarkLabel: string;       // "S&P 500" | "NIFTY 50"
  betaComingSoon: boolean;      // India: beta vs NIFTY not yet wired
  totalValue: number;
  holdingCount: number;
  holdings: HoldingWithRisk[];
  portfolioBeta: number;
  betaLabel: string;         // "Your portfolio moves 35% more than the market"
  var95_dollar: number;      // 1-day 95% VaR in dollars
  var95_pct: number;
  varLabel: string;          // "On a bad day, you could lose up to $X"
  maxDrawdownEst: number;    // estimated max drawdown (beta × SPY historical max drawdown ~34%)
  sectorBreakdown: SectorBreakdown[];
  correlatedPairs: CorrelatedPair[];
  warnings: RiskWarning[];
  riskScore: number;         // 0–100 composite
  riskLabel: "Low" | "Moderate" | "Elevated" | "High";
  riskColor: string;
  proposalImpact?: ProposalImpact;
}

export interface ProposalImpact {
  newBeta: number;
  newTechConcentration: number;
  newMaxConcentration: number;
  description: string;
}

// India (NSE `.NS`) sector map for the NIFTY-100 universe. US SECTOR_MAP keys are
// bare US tickers and never match `.NS` symbols, so India needs its own lookup or
// every position collapses to "Other". Kept small + honest — extend as needed.
const INDIA_SECTOR_MAP: Record<string, string> = {
  "TCS": "Technology", "INFY": "Technology", "WIPRO": "Technology", "HCLTECH": "Technology",
  "TECHM": "Technology", "LTIM": "Technology", "MPHASIS": "Technology", "PERSISTENT": "Technology",
  "HDFCBANK": "Financials", "ICICIBANK": "Financials", "AXISBANK": "Financials", "SBIN": "Financials",
  "KOTAKBANK": "Financials", "BAJFINANCE": "Financials", "BAJAJFINSV": "Financials", "INDUSINDBK": "Financials",
  "HDFCLIFE": "Financials", "SBILIFE": "Financials", "BANKBARODA": "Financials", "PNB": "Financials",
  "RELIANCE": "Energy", "ONGC": "Energy", "BPCL": "Energy", "IOC": "Energy", "GAIL": "Energy", "COALINDIA": "Energy",
  "SUNPHARMA": "Healthcare", "DRREDDY": "Healthcare", "CIPLA": "Healthcare", "DIVISLAB": "Healthcare",
  "APOLLOHOSP": "Healthcare", "TORNTPHARM": "Healthcare", "AUROPHARMA": "Healthcare", "ZYDUSLIFE": "Healthcare",
  "HINDUNILVR": "Consumer Staples", "ITC": "Consumer Staples", "NESTLEIND": "Consumer Staples",
  "BRITANNIA": "Consumer Staples", "TATACONSUM": "Consumer Staples", "DABUR": "Consumer Staples", "MARICO": "Consumer Staples",
  "MARUTI": "Consumer Discretionary", "TATAMOTORS": "Consumer Discretionary", "M&M": "Consumer Discretionary",
  "TITAN": "Consumer Discretionary", "EICHERMOT": "Consumer Discretionary", "HEROMOTOCO": "Consumer Discretionary",
  "BAJAJ-AUTO": "Consumer Discretionary", "TVSMOTOR": "Consumer Discretionary", "DMART": "Consumer Discretionary",
  "LT": "Industrials", "SIEMENS": "Industrials", "ABB": "Industrials", "BEL": "Industrials", "BOSCHLTD": "Industrials",
  "BHARTIARTL": "Communication", "ZOMATO": "Communication", "NAUKRI": "Communication", "IRCTC": "Communication",
  "TATASTEEL": "Materials", "JSWSTEEL": "Materials", "HINDALCO": "Materials", "VEDL": "Materials",
  "ULTRACEMCO": "Materials", "GRASIM": "Materials", "SHREECEM": "Materials", "AMBUJACEM": "Materials",
  "ASIANPAINT": "Materials", "BERGEPAINT": "Materials", "PIDILITIND": "Materials", "JINDALSTEL": "Materials",
  "NTPC": "Utilities", "POWERGRID": "Utilities", "TATAPOWER": "Utilities", "ADANIGREEN": "Utilities", "ADANIPOWER": "Utilities",
  "DLF": "Real Estate", "LODHA": "Real Estate", "ADANIPORTS": "Industrials", "ADANIENT": "Industrials",
};

function indiaSector(symbol: string): string {
  const base = symbol.toUpperCase().replace(/\.(NS|BO)$/, "");
  return INDIA_SECTOR_MAP[base] ?? "Other";
}

// India daily-vol proxy for VaR when we have no NIFTY beta wired. NIFTY 50's
// realized daily vol runs ~1.0% — higher than SPY's ~0.85%. Used directly
// (beta = 1 assumption) so the ₹ VaR figure is honest, not beta-scaled off SPY.
const NIFTY_DAILY_VOL = 0.010;

export interface RiskOptions {
  market?: "us" | "india";
  currency?: string; // "$" | "₹"
}

// ── Core computation ─────────────────────────────────────────────────────────

export function computeRiskMetrics(
  holdings: BrokerHolding[],
  pendingProposals?: Array<{ symbol: string; side: string; qty: number; priceAtProposal: number }>,
  opts: RiskOptions = {},
): RiskMetrics {
  const market = opts.market ?? "us";
  const currency = opts.currency ?? (market === "india" ? "₹" : "$");
  const benchmarkLabel = market === "india" ? "NIFTY 50" : "S&P 500";
  const betaComingSoon = market === "india"; // beta vs NIFTY not yet wired
  if (!holdings.length) {
    return emptyMetrics(market, currency, benchmarkLabel, betaComingSoon);
  }

  const totalValue = holdings.reduce((s, h) => s + h.marketValue, 0);
  if (totalValue <= 0) return emptyMetrics(market, currency, benchmarkLabel, betaComingSoon);

  const isIndia = market === "india";

  // Enrich with sector + beta. India uses its own `.NS` sector map; beta stays a
  // sector-average proxy (vs NIFTY is coming soon — we don't claim SPY beta for ₹).
  const enriched: HoldingWithRisk[] = holdings.map(h => {
    const sector = isIndia ? indiaSector(h.symbol) : (SECTOR_MAP[h.symbol] ?? "Other");
    const beta   = SECTOR_BETA[sector] ?? 1.0;
    const weightPct = h.marketValue / totalValue;
    return { ...h, sector, beta, weightPct, riskContribution: weightPct * beta };
  });

  // Portfolio beta = weighted average sector beta (proxy).
  const portfolioBeta = enriched.reduce((s, h) => s + h.weightPct * h.beta, 0);

  // VaR: US scales SPY daily vol by beta. India has no NIFTY beta wired, so use
  // NIFTY's own daily vol directly (beta-1 assumption) — an honest ₹ figure that
  // doesn't borrow SPY sensitivity.
  const dailyVol = isIndia ? NIFTY_DAILY_VOL : 0.0085;
  const portfolioDailyVol = isIndia ? dailyVol : portfolioBeta * dailyVol;
  const var95_pct    = portfolioDailyVol * 1.645;
  const var95_dollar = totalValue * var95_pct; // amount is in `currency`, not always $

  // Max drawdown estimate: benchmark historical max (~34%), scaled by beta for US;
  // India uses a flat NIFTY drawdown proxy (~38%) since beta isn't wired.
  const maxDrawdownEst = isIndia ? 0.38 : Math.min(0.60, portfolioBeta * 0.34);

  // Sector breakdown
  const sectorTotals: Record<string, number> = {};
  const sectorCounts: Record<string, number> = {};
  for (const h of enriched) {
    sectorTotals[h.sector] = (sectorTotals[h.sector] ?? 0) + h.weightPct;
    sectorCounts[h.sector] = (sectorCounts[h.sector] ?? 0) + 1;
  }
  // India has no free NIFTY sector-weight reference wired, so benchmark weight is
  // 0 and overweight is not claimed (the UI hides the S&P column for India).
  const sectorBreakdown: SectorBreakdown[] = Object.entries(sectorTotals)
    .sort((a, b) => b[1] - a[1])
    .map(([sector, weightPct]) => {
      const benchWeight = isIndia ? 0 : (SP500_SECTOR_WEIGHTS[sector] ?? 0);
      return {
        sector,
        weightPct,
        sp500WeightPct: benchWeight,
        overweightPct: isIndia ? 0 : weightPct - benchWeight,
        holdingCount: sectorCounts[sector],
      };
    });

  // Correlated pairs (from known map, only for held symbols)
  const symbols = new Set(enriched.map(h => h.symbol));
  const correlatedPairs: CorrelatedPair[] = [];
  const seenPairs = new Set<string>();
  for (const [s1, corrs] of Object.entries(KNOWN_CORR)) {
    if (!symbols.has(s1)) continue;
    for (const [s2, corr] of Object.entries(corrs)) {
      if (!symbols.has(s2)) continue;
      const key = [s1, s2].sort().join(":");
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      if (corr >= 0.65) {
        correlatedPairs.push({ symbol1: s1, symbol2: s2, correlation: corr, severity: corr >= 0.80 ? "high" : "medium" });
      }
    }
  }
  correlatedPairs.sort((a, b) => b.correlation - a.correlation);

  // Warnings
  const warnings: RiskWarning[] = [];
  const maxHolding = enriched.reduce((mx, h) => h.weightPct > mx.weightPct ? h : mx, enriched[0]);

  if (maxHolding.weightPct > 0.20) {
    warnings.push({ type: "concentration", severity: "critical", message: `${maxHolding.symbol} is ${(maxHolding.weightPct * 100).toFixed(0)}% of portfolio — well above the 15% recommended max`, action: `Trim ${maxHolding.symbol} to reduce concentration risk` });
  } else if (maxHolding.weightPct > 0.15) {
    warnings.push({ type: "concentration", severity: "warn", message: `${maxHolding.symbol} is ${(maxHolding.weightPct * 100).toFixed(0)}% of portfolio — slightly above 15% max`, action: `Consider trimming ${maxHolding.symbol}` });
  }

  const techWeight = sectorTotals["Technology"] ?? 0;
  const techOW = isIndia ? "" : ` — ${Math.round(techWeight / (SP500_SECTOR_WEIGHTS["Technology"] ?? 0.31))}× overweight vs S&P 500`;
  if (techWeight > 0.55) {
    warnings.push({ type: "sector", severity: "critical", message: `${(techWeight * 100).toFixed(0)}% in Technology${techOW}`, action: "Add non-tech positions to diversify" });
  } else if (techWeight > 0.40) {
    warnings.push({ type: "sector", severity: "warn", message: `${(techWeight * 100).toFixed(0)}% in Technology${techOW}`, action: "Consider diversifying into Healthcare or Financials" });
  }

  if (portfolioBeta > 1.5) {
    warnings.push({ type: "beta", severity: "warn", message: `Portfolio beta ${portfolioBeta.toFixed(2)} — if market drops 10%, expect ~${(portfolioBeta * 10).toFixed(0)}% loss`, action: "Add defensive positions (Utilities, Consumer Staples) to reduce beta" });
  }

  for (const pair of correlatedPairs.filter(p => p.severity === "high").slice(0, 2)) {
    warnings.push({ type: "correlation", severity: "warn", message: `${pair.symbol1} + ${pair.symbol2} are ${(pair.correlation * 100).toFixed(0)}% correlated — less diversification than you think`, action: `Holding both gives limited diversification benefit` });
  }

  if (enriched.length === 1) {
    warnings.push({ type: "no_diversification", severity: "critical", message: "Single-stock portfolio — one bad earnings = entire portfolio at risk", action: "Add at least 5–8 positions across different sectors" });
  }

  // Risk score: 0–100 composite (higher = more risk)
  let riskScore = 0;
  riskScore += Math.min(40, portfolioBeta * 20);             // beta contribution (max 40)
  riskScore += Math.min(20, maxHolding.weightPct * 100);     // concentration (max 20)
  riskScore += Math.min(20, (techWeight / 0.31) * 5);        // sector overweight (max 20)
  riskScore += Math.min(10, correlatedPairs.filter(p => p.severity === "high").length * 5); // corr (max 10)
  riskScore += enriched.length < 5 ? 10 : 0;                // undiversified (max 10)
  riskScore = Math.min(100, Math.round(riskScore));

  const riskLabel = riskScore < 30 ? "Low" : riskScore < 55 ? "Moderate" : riskScore < 75 ? "Elevated" : "High";
  const riskColor = riskScore < 30 ? "#34D399" : riskScore < 55 ? "#FBBF24" : riskScore < 75 ? "#F97316" : "#F87171";

  const betaLabel = portfolioBeta > 1
    ? `Your portfolio moves ${Math.round((portfolioBeta - 1) * 100)}% MORE than the market`
    : portfolioBeta < 1
    ? `Your portfolio moves ${Math.round((1 - portfolioBeta) * 100)}% LESS than the market`
    : "Your portfolio moves in line with the market";

  const varLabel = `On a bad day (1-in-20), you could lose up to ${currency}${var95_dollar.toFixed(0)}`;

  // Proposal impact (if pending proposals provided)
  let proposalImpact: ProposalImpact | undefined;
  if (pendingProposals?.length) {
    const newHoldings = [...enriched];
    for (const p of pendingProposals) {
      if (p.side !== "buy") continue;
      const addedValue = p.qty * p.priceAtProposal;
      const newTotal   = totalValue + addedValue;
      const sector     = isIndia ? indiaSector(p.symbol) : (SECTOR_MAP[p.symbol] ?? "Other");
      const existing   = newHoldings.find(h => h.symbol === p.symbol);
      if (existing) {
        existing.marketValue += addedValue;
      } else {
        newHoldings.push({ symbol: p.symbol, qty: p.qty, currentPrice: p.priceAtProposal, marketValue: addedValue, side: "long", source: "internal", sector, beta: SECTOR_BETA[sector] ?? 1.0, weightPct: 0, riskContribution: 0 });
      }
      for (const h of newHoldings) h.weightPct = h.marketValue / newTotal;
    }
    const newBeta = newHoldings.reduce((s, h) => s + h.weightPct * h.beta, 0);
    const newTech = newHoldings.filter(h => h.sector === "Technology").reduce((s, h) => s + h.weightPct, 0);
    const newMax  = Math.max(...newHoldings.map(h => h.weightPct));
    proposalImpact = {
      newBeta,
      newTechConcentration: newTech,
      newMaxConcentration: newMax,
      description: `If all pending proposals are approved: beta ${portfolioBeta.toFixed(2)} → ${newBeta.toFixed(2)}, tech ${(techWeight * 100).toFixed(0)}% → ${(newTech * 100).toFixed(0)}%`,
    };
  }

  return {
    market, currency, benchmarkLabel, betaComingSoon,
    totalValue, holdingCount: enriched.length,
    holdings: enriched.sort((a, b) => b.marketValue - a.marketValue),
    portfolioBeta, betaLabel,
    var95_dollar, var95_pct, varLabel,
    maxDrawdownEst,
    sectorBreakdown, correlatedPairs, warnings,
    riskScore, riskLabel, riskColor,
    proposalImpact,
  };
}

function emptyMetrics(
  market: "us" | "india" = "us",
  currency = "$",
  benchmarkLabel = "S&P 500",
  betaComingSoon = false,
): RiskMetrics {
  return {
    market, currency, benchmarkLabel, betaComingSoon,
    totalValue: 0, holdingCount: 0, holdings: [],
    portfolioBeta: 0, betaLabel: "No holdings",
    var95_dollar: 0, var95_pct: 0, varLabel: "No holdings to assess",
    maxDrawdownEst: 0,
    sectorBreakdown: [], correlatedPairs: [], warnings: [],
    riskScore: 0, riskLabel: "Low", riskColor: "#34D399",
  };
}
