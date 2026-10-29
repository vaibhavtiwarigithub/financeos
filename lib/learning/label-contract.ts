/** Version of the forward-outcome semantics consumed by inferential learning. */
export const CURRENT_LABEL_CONTRACT_VERSION = "decision_mark_v2" as const;

export type LabelContractVersion = typeof CURRENT_LABEL_CONTRACT_VERSION | "legacy_v1";
