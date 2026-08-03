import type { AlgoStrategy, StrategyConditions } from "@/lib/strategy-definitions";

export type FeatureLifecycle = "active_v1" | "measure_only" | "observed_only" | "manual_only" | "unsupported";
export type InstrumentFamily = "operating_company" | "adr" | "etf" | "leveraged_etf" | "bank" | "reit" | "unknown";

export interface FeatureCatalogEntry {
  id: string;
  label: string;
  family: "trend" | "volatility" | "participation" | "quality" | "value" | "growth" | "event";
  lifecycle: FeatureLifecycle;
  applicableTo: readonly InstrumentFamily[];
  detail: string;
}

// This is a typed read model of the current product contract. It is intentionally
// not a second evaluator: live score formulas remain in lib/data/scores.ts.
export const FEATURE_CATALOG: readonly FeatureCatalogEntry[] = [
  { id: "rsi14", label: "RSI(14)", family: "trend", lifecycle: "active_v1", applicableTo: ["operating_company", "adr", "etf", "leveraged_etf", "bank", "reit"], detail: "Completed-candle momentum input in the current technical score." },
  { id: "ema20_50", label: "EMA20/50 state", family: "trend", lifecycle: "active_v1", applicableTo: ["operating_company", "adr", "etf", "leveraged_etf", "bank", "reit"], detail: "Completed-candle trend-state inputs in the current technical score." },
  { id: "trend20d", label: "20-day trend", family: "trend", lifecycle: "active_v1", applicableTo: ["operating_company", "adr", "etf", "leveraged_etf", "bank", "reit"], detail: "Completed-candle short trend input in the current technical score." },
  { id: "volume_vs_avg20", label: "Volume versus 20-day average", family: "participation", lifecycle: "active_v1", applicableTo: ["operating_company", "adr", "etf", "leveraged_etf", "bank", "reit"], detail: "Direction-confirming participation input, never its own directional vote." },
  { id: "atr_breakdown", label: "ATR breakdown guard", family: "volatility", lifecycle: "active_v1", applicableTo: ["operating_company", "adr", "etf", "leveraged_etf", "bank", "reit"], detail: "A deterministic downside veto, not a separate alpha feature." },
  { id: "sector_relative_pe", label: "Sector-relative P/E", family: "value", lifecycle: "active_v1", applicableTo: ["operating_company", "adr", "bank", "reit"], detail: "Used only when taxonomy maps safely; not applicable to funds." },
  { id: "profit_margin", label: "Profit margin", family: "quality", lifecycle: "active_v1", applicableTo: ["operating_company", "adr", "bank", "reit"], detail: "Current reported-fundamental input." },
  { id: "roe", label: "Return on equity", family: "quality", lifecycle: "active_v1", applicableTo: ["operating_company", "adr", "bank", "reit"], detail: "Current reported-fundamental input." },
  { id: "eps_sign", label: "EPS sign", family: "quality", lifecycle: "active_v1", applicableTo: ["operating_company", "adr", "bank", "reit"], detail: "Current reported-fundamental input." },
  { id: "revenue_growth_yoy", label: "Revenue growth YoY", family: "growth", lifecycle: "active_v1", applicableTo: ["operating_company", "adr", "bank", "reit"], detail: "Current reported-fundamental input." },
  { id: "relative_strength_60d", label: "60-day relative strength", family: "trend", lifecycle: "measure_only", applicableTo: ["operating_company", "adr", "etf", "leveraged_etf", "bank", "reit"], detail: "Measured in the Edge lab; it does not change the live score." },
  { id: "macd_atr", label: "MACD histogram / ATR", family: "trend", lifecycle: "measure_only", applicableTo: ["operating_company", "adr", "etf", "leveraged_etf", "bank", "reit"], detail: "Technical challenger in the predeclared calibration trial family." },
  { id: "signed_adx", label: "Signed ADX(14)", family: "trend", lifecycle: "measure_only", applicableTo: ["operating_company", "adr", "etf", "leveraged_etf", "bank", "reit"], detail: "Technical challenger in the predeclared calibration trial family." },
  { id: "gross_profitability", label: "Gross profitability", family: "quality", lifecycle: "measure_only", applicableTo: ["operating_company", "adr"], detail: "Awaiting a qualified point-in-time fundamental contract." },
  { id: "debt_to_equity", label: "Debt to equity", family: "quality", lifecycle: "measure_only", applicableTo: ["operating_company", "adr"], detail: "Awaiting a qualified point-in-time fundamental contract." },
  { id: "fcf_yield", label: "Free-cash-flow yield", family: "value", lifecycle: "measure_only", applicableTo: ["operating_company", "adr"], detail: "Awaiting a qualified point-in-time fundamental contract." },
  { id: "earnings_surprise_revision", label: "Earnings surprise and revisions", family: "event", lifecycle: "observed_only", applicableTo: ["operating_company", "adr"], detail: "Requires a dated actual-versus-consensus source before it can be measured." },
  { id: "analyst_target", label: "Analyst target price", family: "event", lifecycle: "observed_only", applicableTo: ["operating_company", "adr", "bank", "reit"], detail: "Stored for context only; it earns zero live-score points." },
  { id: "fibonacci", label: "Fibonacci levels", family: "trend", lifecycle: "unsupported", applicableTo: ["operating_company", "adr", "etf", "leveraged_etf", "bank", "reit"], detail: "Not a registered deterministic feature trial." },
];

const TECHNICAL_CONDITION_STATE: Record<keyof NonNullable<StrategyConditions["technical"]>, FeatureLifecycle> = {
  rsi_min: "manual_only",
  rsi_max: "manual_only",
  price_above_ma50: "manual_only",
  price_above_ma200: "unsupported",
  volume_surge: "unsupported",
  macd_cross_up: "measure_only",
};

const FUNDAMENTAL_CONDITION_STATE: Record<keyof NonNullable<StrategyConditions["fundamental"]>, FeatureLifecycle> = {
  revenue_growth_min: "manual_only",
  pe_max: "manual_only",
  pe_min: "manual_only",
  // Every fundamental condition below is carried into `AlgoStrategy.scan_filters`
  // and sent to the Financial Datasets screener by the manual scan route, so the
  // Scanner does evaluate them. `measure_only` here would have told the owner a
  // condition needs shadow evidence when the manual tool already applies it.
  fcf_yield_min: "manual_only",
  debt_equity_max: "manual_only",
  roe_min: "manual_only",
  gross_margin_min: "manual_only",
};

export interface StrategySupportSummary {
  automated: false;
  scannerSupported: string[];
  shadowOnly: string[];
  unsupported: string[];
}

function labelFor(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, char => char.toUpperCase());
}

export function assessStrategyConditions(conditions: StrategyConditions): StrategySupportSummary {
  const scannerSupported: string[] = [];
  const shadowOnly: string[] = [];
  const unsupported: string[] = [];
  for (const key of Object.keys(conditions.technical ?? {}) as Array<keyof NonNullable<StrategyConditions["technical"]>>) {
    const state = TECHNICAL_CONDITION_STATE[key];
    if (state === "manual_only") scannerSupported.push(labelFor(key));
    else if (state === "measure_only") shadowOnly.push(labelFor(key));
    else unsupported.push(labelFor(key));
  }
  for (const key of Object.keys(conditions.fundamental ?? {}) as Array<keyof NonNullable<StrategyConditions["fundamental"]>>) {
    const state = FUNDAMENTAL_CONDITION_STATE[key];
    if (state === "manual_only") scannerSupported.push(labelFor(key));
    else if (state === "measure_only") shadowOnly.push(labelFor(key));
    else unsupported.push(labelFor(key));
  }
  return { automated: false, scannerSupported, shadowOnly, unsupported };
}

export function strategySupport(strategy: AlgoStrategy): StrategySupportSummary {
  return assessStrategyConditions(strategy.conditions);
}

export function instrumentFamily(input: { assetClass?: string | null; instrumentKind?: string | null }): InstrumentFamily {
  const kind = String(input.instrumentKind ?? "").toLowerCase();
  const asset = String(input.assetClass ?? "").toLowerCase();
  if (kind === "leveraged_or_inverse_etf") return "leveraged_etf";
  if (kind.includes("reit") || asset === "reit") return "reit";
  if (kind.includes("bank") || asset === "bank") return "bank";
  if (kind.includes("adr") || asset === "adr") return "adr";
  if (kind.includes("etf") || asset === "etf" || asset === "metal_fund") return "etf";
  // `assetClass` reaches this function from two vocabularies: InstrumentKind
  // (us_equity / india_equity) and JournalAssetType (company / india_company).
  // Only the first was matched, so an ordinary listed company resolved to
  // "unknown" and the Research funnel then reported every live v1 input as
  // inapplicable to the very decision it had just scored.
  if (kind.includes("equity") || asset === "stock" || asset === "equity"
      || asset === "company" || asset === "india_company") return "operating_company";
  return "unknown";
}

export function featureAuditForInstrument(input: { assetClass?: string | null; instrumentKind?: string | null }) {
  const family = instrumentFamily(input);
  // An unclassified instrument is unknown, not proven incompatible. Historical
  // decisions written before instrument capture existed carry no kind at all;
  // claiming their inputs were inapplicable would misstate the audit trail.
  if (family === "unknown") return { family, active: [], inapplicable: [], measured: [] };
  const active = FEATURE_CATALOG.filter(feature => feature.lifecycle === "active_v1" && feature.applicableTo.includes(family));
  const inapplicable = FEATURE_CATALOG.filter(feature => feature.lifecycle === "active_v1" && !feature.applicableTo.includes(family));
  const measured = FEATURE_CATALOG.filter(feature => feature.lifecycle === "measure_only" && feature.applicableTo.includes(family));
  return { family, active, inapplicable, measured };
}
