// Isolated L1 measurement contract for long daily-reset ETFs.
//
// This module deliberately cannot produce a trade, order quantity, paper fill,
// stop, target, or score. It only records whether the minimum inputs for a
// future, separately approved experiment were available at one ET session.

export const LEVERAGED_ETF_SHADOW_POLICY_VERSION = "leveraged-etf-shadow-l1-v1";

export type LeveragedShadowSymbol = "TQQQ" | "SOXL" | "SQQQ" | "SOXS";

// SQQQ/SOXS (2026-09-23): observe_only shadow entries only -- no RPC, no cron
// door, no lifecycle module exists or is planned for them. Per the owner's
// standing inverse-fund refusal (symbol-policy.ts's block; CLAUDE.md push-back
// mandate), this widening is research-only and structurally cannot become a
// trade path: `decision` stays CHECK-locked to 'observe_only' in the DB.
export const LEVERAGED_SHADOW_UNIVERSE: Record<LeveragedShadowSymbol, {
  underlyingSymbol: "QQQ" | "SOXX";
  leverage: 3;
  family: "nasdaq" | "semiconductors";
  direction: "long" | "inverse";
}> = {
  TQQQ: { underlyingSymbol: "QQQ", leverage: 3, family: "nasdaq", direction: "long" },
  SOXL: { underlyingSymbol: "SOXX", leverage: 3, family: "semiconductors", direction: "long" },
  SQQQ: { underlyingSymbol: "QQQ", leverage: 3, family: "nasdaq", direction: "inverse" },
  SOXS: { underlyingSymbol: "SOXX", leverage: 3, family: "semiconductors", direction: "inverse" },
};

export type LeveragedEtfShadowInput = {
  observedAt: string;
  symbol: string;
  etfPrice?: number | null;
  underlyingPrice?: number | null;
  bid?: number | null;
  ask?: number | null;
  quoteAsOf?: string | null;
  underlyingQuoteAsOf?: string | null;
  realizedVol20dPct?: number | null;
  atr14Pct?: number | null;
  trend20dPct?: number | null;
  underlyingTrend20dPct?: number | null;
  dollarVolume?: number | null;
  /** Pearson correlation of trailing-20-session daily returns vs. the OTHER
   * long-leveraged member of this pair (SOXL<->TQQQ). Informational only —
   * see correlation20d's own doc comment. Null for SQQQ/SOXS (no peer
   * computed) or when either series has insufficient history. */
  correlationToPeer20d?: number | null;
};

export type LeveragedEtfShadowObservation = {
  policyVersion: typeof LEVERAGED_ETF_SHADOW_POLICY_VERSION;
  symbol: LeveragedShadowSymbol;
  underlyingSymbol: "QQQ" | "SOXX";
  marketSession: string;
  observedAt: string;
  window: "inside_1100_et" | "outside_1100_et";
  measurementStatus: "complete" | "incomplete";
  missing: string[];
  features: Record<string, number | null>;
  quote: { etfPrice: number | null; underlyingPrice: number | null; bid: number | null; ask: number | null; spreadBps: number | null; quoteAsOf: string | null; underlyingQuoteAsOf: string | null };
  decision: "observe_only";
};

function finite(value: unknown): number | null {
  if (value == null || typeof value === "boolean" || (typeof value === "string" && !value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function etParts(iso: string) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) throw new Error("observedAt must be an ISO timestamp");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date).reduce<Record<string, string>>((out, part) => ({ ...out, [part.type]: part.value }), {});
  return { session: `${parts.year}-${parts.month}-${parts.day}`, weekday: parts.weekday, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

/** 11:00–11:14 ET is an observation window only, never an execution authority. */
export function isLeveragedObservationWindow(observedAt: string): boolean {
  const { weekday, minute } = etParts(observedAt);
  return !["Sat", "Sun"].includes(weekday) && minute >= 11 * 60 && minute < 11 * 60 + 15;
}

export function buildLeveragedEtfShadowObservation(input: LeveragedEtfShadowInput): LeveragedEtfShadowObservation {
  const symbol = input.symbol.trim().toUpperCase() as LeveragedShadowSymbol;
  const policy = LEVERAGED_SHADOW_UNIVERSE[symbol];
  if (!policy) throw new Error("only explicitly approved leveraged shadow symbols may be observed");
  const etfPrice = finite(input.etfPrice);
  const underlyingPrice = finite(input.underlyingPrice);
  const bid = finite(input.bid);
  const ask = finite(input.ask);
  const missing: string[] = [];
  if (etfPrice == null || etfPrice <= 0) missing.push("etf_price");
  if (underlyingPrice == null || underlyingPrice <= 0) missing.push("underlying_price");
  if (bid == null || bid <= 0) missing.push("bid");
  if (ask == null || ask <= 0 || (bid != null && ask < bid)) missing.push("ask");
  if (!input.quoteAsOf) missing.push("quote_as_of");
  if (!input.underlyingQuoteAsOf) missing.push("underlying_quote_as_of");
  for (const [key, value] of Object.entries({ realized_vol_20d_pct: input.realizedVol20dPct, atr14_pct: input.atr14Pct, trend20d_pct: input.trend20dPct, underlying_trend20d_pct: input.underlyingTrend20dPct, dollar_volume: input.dollarVolume })) {
    if (finite(value) == null) missing.push(key);
  }
  const { session } = etParts(input.observedAt);
  return {
    policyVersion: LEVERAGED_ETF_SHADOW_POLICY_VERSION,
    symbol,
    underlyingSymbol: policy.underlyingSymbol,
    marketSession: session,
    observedAt: input.observedAt,
    window: isLeveragedObservationWindow(input.observedAt) ? "inside_1100_et" : "outside_1100_et",
    measurementStatus: missing.length ? "incomplete" : "complete",
    missing,
    features: {
      realized_vol_20d_pct: finite(input.realizedVol20dPct), atr14_pct: finite(input.atr14Pct), trend20d_pct: finite(input.trend20dPct),
      underlying_trend20d_pct: finite(input.underlyingTrend20dPct), dollar_volume: finite(input.dollarVolume), leverage: policy.leverage,
      correlation_to_peer_20d: finite(input.correlationToPeer20d),
    },
    quote: {
      etfPrice, underlyingPrice, bid, ask,
      spreadBps: bid != null && ask != null && bid > 0 ? ((ask - bid) / bid) * 10_000 : null,
      quoteAsOf: input.quoteAsOf ?? null, underlyingQuoteAsOf: input.underlyingQuoteAsOf ?? null,
    },
    decision: "observe_only",
  };
}
