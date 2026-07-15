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
    ? " [no thesis narrative — direction from deterministic gate]"
    : (input.llmDirection && input.llmDirection !== direction
        ? ` [llm=${input.llmDirection} overridden by gate → ${direction}]`
        : "");
  return { direction, note };
}
