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
