// Deterministic signal-direction gate — the ONLY place a research signal's
// executable direction is decided. Pure function so tests can prove the
// invariant: no LLM output can open, close, or flip a position.
//
// Rules (in priority order):
//   1. Held + score below threshold  → "short" (deterministic exit signal).
//      SELL capability on holdings is a CLAUDE.md locked rule; it is evidence-
//      driven (score), never LLM-driven. Checked BEFORE thin-evidence so a
//      genuinely decayed holding still exits even when dimensions are sparse.
//   2. Thin evidence (<2 usable dims) → "neutral" (abstain from NEW entries).
//   3. Otherwise mechanical: score >= threshold → "long", else "neutral".
//
// The LLM's own direction opinion (`llmDirection`) NEVER influences the output;
// it is only echoed into the note when it disagrees, and preserved upstream as
// advisory in research_packets.raw_data._original_direction.

export interface DirectionGateInput {
  isHeld: boolean;
  analystScore: number;
  scoreThreshold: number | null | undefined; // mandate threshold; default 60
  thinEvidence: boolean;
  includedDimsCount: number;
  llmDirection: string | undefined; // parsed thesis direction (advisory only)
}

export interface DirectionGateResult {
  direction: "long" | "neutral" | "short";
  note: string;
}

export interface DeterministicNarrativeInput {
  analystScore: number;
  scoreThreshold: number | null | undefined;
  direction: "long" | "neutral" | "short" | string;
  isHeld: boolean;
  includedDimsCount: number;
  entryEligible: boolean;
  breakdownVetoed?: boolean;
  earningsRepricingPending?: boolean;
  scores: Record<string, number | null | undefined>;
}

// This is explanation only. It intentionally derives its wording from the same
// persisted numeric evidence and gates that make the decision; an LLM outage
// can never turn a transparent reason into a fabricated thesis.
export function buildDeterministicNarrative(input: DeterministicNarrativeInput): string {
  const threshold = input.scoreThreshold ?? 60;
  const labels: Record<string, string> = {
    fundamental: "fundamentals", technical: "technicals", sentiment: "sentiment",
    macro: "macro", insider: "insider activity",
  };
  const dimensions = Object.entries(input.scores)
    .filter(([, score]) => Number.isFinite(score))
    .map(([key, score]) => ({ label: labels[key] ?? key, score: Number(score) }))
    .sort((a, b) => b.score - a.score);
  const strongest = dimensions.slice(0, 2).map(d => `${d.label} ${d.score}`).join(" and ");
  const weakest = dimensions.length ? dimensions[dimensions.length - 1] : null;
  const evidence = strongest
    ? ` Strongest recorded evidence: ${strongest}.${weakest && weakest.score < 50 ? ` Main constraint: ${weakest.label} ${weakest.score}.` : ""}`
    : " No usable score dimensions were recorded.";

  if (input.isHeld && input.direction === "short") {
    return `Exit review: composite score ${input.analystScore}/100 fell below the ${threshold} holding threshold.${evidence}`;
  }
  if (input.earningsRepricingPending) {
    return `No entry: a post-earnings daily candle is required before the ${input.analystScore}/100 score can be acted on.${evidence}`;
  }
  if (input.breakdownVetoed) {
    return `No entry: a breakdown-risk veto blocks a new position despite composite score ${input.analystScore}/100.${evidence}`;
  }
  if (input.includedDimsCount < 2) {
    return `No entry: only ${input.includedDimsCount}/5 usable score dimensions were available; new positions require at least two.${evidence}`;
  }
  if (input.entryEligible) {
    return `Eligible for downstream risk and portfolio checks: composite score ${input.analystScore}/100 cleared the ${threshold} entry threshold.${evidence}`;
  }
  return `No entry: composite score ${input.analystScore}/100 is below the ${threshold} entry threshold.${evidence}`;
}

export function resolveSignalDirection(input: DirectionGateInput): DirectionGateResult {
  const threshold = input.scoreThreshold ?? 60;
  const llmParseFailed = !input.llmDirection;

  if (input.isHeld && input.analystScore < threshold) {
    return {
      direction: "short",
      note: ` [deterministic exit: held and score ${input.analystScore} < threshold ${threshold}]`,
    };
  }
  if (input.thinEvidence) {
    return {
      direction: "neutral",
      note: ` [abstained: thin evidence (${input.includedDimsCount}/5 dims)]`,
    };
  }
  const direction = input.analystScore >= threshold ? "long" : "neutral";
  const note = llmParseFailed
    ? " [deterministic decision; LLM thesis unavailable]"
    : (input.llmDirection && input.llmDirection !== direction
        ? ` [llm=${input.llmDirection} overridden by gate → ${direction}]`
        : "");
  return { direction, note };
}
