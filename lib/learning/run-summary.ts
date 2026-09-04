export interface LearnerRunCounts {
  reconciled: number;
  reconciledWins: number;
  reconciledLosses: number;
  totalClosed: number;
  totalWins: number;
  totalLosses: number;
}

export function formatLearnerRunSummary(
  counts: LearnerRunCounts,
  hypotheses: number,
  mutations: number,
): string {
  return `Reconciled ${counts.reconciled} orphan trades (${counts.reconciledWins}W/${counts.reconciledLosses}L) | Total closed: ${counts.totalClosed} (${counts.totalWins}W/${counts.totalLosses}L). ${hypotheses} hypotheses, ${mutations} mutations.`;
}

export function formatLearnerFallbackMermaid(input: {
  signals: number;
  totalClosed: number;
  reconciledOrphans: number;
  hypotheses: number;
  macroChecked: boolean;
  priorsLoaded: boolean;
  steps: number;
}): string {
  return `flowchart TD\n  INPUTS["📥 Inputs\\n• ${input.signals} signals\\n• ${input.totalClosed} closed trades in learning corpus\\n• macro: ${input.macroChecked ? "checked" : "not checked"}\\n• priors: ${input.priorsLoaded ? "loaded" : "not loaded"}"]\n  ANALYSIS["🔍 Operations\\n• ${input.reconciledOrphans} orphan trades reconciled this run"]\n  HYPOTHESES["💡 Hypotheses\\n• ${input.hypotheses} saved"]\n  COMPLETION["⚠ Incomplete agent output\\n• finish payload missing after ${input.steps} steps"]\n  INPUTS --> ANALYSIS --> HYPOTHESES --> COMPLETION`;
}
