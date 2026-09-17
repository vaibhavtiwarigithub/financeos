// Crypto broker capability policy. This is deliberately a pure interpretation
// of a tools/list snapshot: it never calls a broker endpoint or infers that an
// individual pair is tradable merely because a broadly named tool exists.

export const CRYPTO_READ_TOOL_REQUIREMENTS = [
  "get_crypto_account_onboarding_info",
  "get_currency_pairs",
  "get_crypto_quotes",
  "get_crypto_positions",
  "get_crypto_orders",
] as const;

export const CRYPTO_PREVIEW_TOOL = "preview_crypto_order";
export const CRYPTO_ORDER_TOOL = "place_crypto_order";
export const CRYPTO_CANCEL_TOOL = "cancel_crypto_order";

export type CryptoBrokerCapability = {
  readReady: boolean;
  previewAdvertised: boolean;
  orderAdvertised: boolean;
  cancelAdvertised: boolean;
  missingReadTools: string[];
};

/**
 * A tool advertisement is only capability evidence. It is not account
 * eligibility, pair eligibility, an executable quote, or permission to trade.
 */
export function assessCryptoBrokerCapability(toolNames: readonly string[]): CryptoBrokerCapability {
  const tools = new Set(toolNames.map((tool) => tool.trim()));
  const missingReadTools = CRYPTO_READ_TOOL_REQUIREMENTS.filter((tool) => !tools.has(tool));
  return {
    readReady: missingReadTools.length === 0,
    previewAdvertised: tools.has(CRYPTO_PREVIEW_TOOL),
    orderAdvertised: tools.has(CRYPTO_ORDER_TOOL),
    cancelAdvertised: tools.has(CRYPTO_CANCEL_TOOL),
    missingReadTools,
  };
}
