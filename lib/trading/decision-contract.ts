/**
 * Versioned join contract across research, construction, proposals and execution.
 *
 * The immutable decision_observations row remains the canonical source for
 * scores/formula lineage/mandate provenance. Downstream records carry only this
 * compact reference, avoiding a second mutable copy of those fields.
 */
export const DECISION_CONTRACT_VERSION = "kairos-decision-ref.v1" as const;

export type DecisionContractMarket = "us" | "india" | "crypto";
export type DecisionContractLayer = "research" | "portfolio" | "proposal" | "execution";

export interface DecisionContractRef {
  version: typeof DECISION_CONTRACT_VERSION;
  id: string;
  signal_id: string;
  market: DecisionContractMarket;
  symbol: string;
  layer: DecisionContractLayer;
  stage: string;
}

const MARKET_SET = new Set<string>(["us", "india", "crypto"]);
const LAYER_BY_STAGE: Record<string, DecisionContractLayer> = {
  research: "research",
  freshness: "research",
  risk_plan: "portfolio",
  portfolio_constructor: "portfolio",
  trade_plan: "portfolio",
  sector_gate: "portfolio",
  liquidity_gate: "portfolio",
  reentry_gate: "portfolio",
  existing_position_gate: "portfolio",
  pyramid_gate: "portfolio",
  capital_rotation: "portfolio",
  covariance_sizing_shadow: "portfolio",
  sizing: "portfolio",
  proposal: "proposal",
  execution: "execution",
};

/**
 * Returns null for non-symbol/global events. A contract ID is stable and
 * deterministic for the immutable signal, and always market-scoped.
 */
export function decisionContractRef(input: {
  signalId: string | null | undefined;
  market: string | null | undefined;
  symbol: string | null | undefined;
  stage: string;
}): DecisionContractRef | null {
  const signalId = String(input.signalId ?? "").trim();
  const market = String(input.market ?? "").trim().toLowerCase();
  const symbol = String(input.symbol ?? "").trim().toUpperCase();
  const stage = String(input.stage ?? "").trim();
  const layer = LAYER_BY_STAGE[stage];
  if (!signalId || !MARKET_SET.has(market) || !symbol || !stage || !layer) return null;

  return {
    version: DECISION_CONTRACT_VERSION,
    id: `${market}:${signalId}`,
    signal_id: signalId,
    market: market as DecisionContractMarket,
    symbol,
    layer,
    stage,
  };
}

/**
 * Adds the cross-layer reference to existing JSON audit payloads. It never
 * overwrites existing fields or changes the business decision represented by
 * the payload.
 */
export function attachDecisionContractRef<T>(
  detail: T,
  input: Parameters<typeof decisionContractRef>[0],
): T | (T extends object ? T : Record<string, unknown>) {
  const ref = decisionContractRef(input);
  if (!ref) return detail;
  const base = detail && typeof detail === "object" && !Array.isArray(detail)
    ? detail as Record<string, unknown>
    : { value: detail };
  return { ...base, decision_contract_ref: ref } as any;
}
