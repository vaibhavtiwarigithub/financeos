import "server-only";

/**
 * The sole permitted LLM boundary for a future Capital Advisor narrator. It
 * deliberately excludes addresses, lender identifiers, account numbers, and
 * any authority to alter a calculation. No caller is allowed to feed its text
 * back into a decision state or write it to a money path.
 */
export type CapitalNarrativeEnvelope = {
  decisionState: string;
  deterministicReason: string;
  evidenceQuality: "verified" | "owner_assumption" | "insufficient";
  constraints: { liquidityFloorPreserved: boolean; currency: "USD" | "INR" };
  ranges?: { lower: number; base: number; upper: number };
};

export function buildCapitalNarrativeEnvelope(input: CapitalNarrativeEnvelope): Readonly<CapitalNarrativeEnvelope> {
  return Object.freeze({
    ...input,
    constraints: Object.freeze({ ...input.constraints }),
    ranges: input.ranges ? Object.freeze({ ...input.ranges }) : undefined,
  });
}
