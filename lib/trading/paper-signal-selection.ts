export interface PaperSignalCandidate {
  id: string;
  symbol: string;
  market?: string | null;
  asset_class?: string | null;
  analyst_score: number | string | null;
  created_at: string;
}

export interface PaperSignalSelectionOptions {
  /** Legacy hard exclusion for callers that intentionally disallow a held symbol. */
  excludedSymbols?: ReadonlySet<string>;
  /** Held alpha names are ranked separately so qualified top-ups do not crowd out new entries. */
  heldSymbols?: ReadonlySet<string>;
  topUpLimit?: number;
}

function candidateMarket(signal: PaperSignalCandidate): "us" | "india" {
  if (signal.market === "india" || signal.asset_class === "india") return "india";
  return "us";
}

function isBetter(candidate: PaperSignalCandidate, incumbent: PaperSignalCandidate): boolean {
  const candidateScore = Number(candidate.analyst_score);
  const incumbentScore = Number(incumbent.analyst_score);
  if (candidateScore !== incumbentScore) return candidateScore > incumbentScore;
  if (candidate.created_at !== incumbent.created_at) return candidate.created_at > incumbent.created_at;
  return candidate.id > incumbent.id;
}

export function selectBestPaperSignals<T extends PaperSignalCandidate>(
  rows: T[],
  market: "us" | "india",
  limit: number,
  options: PaperSignalSelectionOptions = {},
): { selected: T[]; topUpCandidates: T[]; duplicateIds: string[]; excludedIds: string[] } {
  const best = new Map<string, T>();
  const heldBest = new Map<string, T>();
  const duplicateIds: string[] = [];
  const excludedIds: string[] = [];

  for (const row of rows) {
    if (candidateMarket(row) !== market) continue;
    const symbol = String(row.symbol ?? "").trim().toUpperCase();
    if (!symbol) continue;
    if (options.excludedSymbols?.has(symbol)) {
      excludedIds.push(row.id);
      continue;
    }
    const target = options.heldSymbols?.has(symbol) ? heldBest : best;
    const incumbent = target.get(symbol);
    if (!incumbent) target.set(symbol, row);
    else if (isBetter(row, incumbent)) {
      duplicateIds.push(incumbent.id);
      target.set(symbol, row);
    } else duplicateIds.push(row.id);
  }

  const selected = [...best.values()]
    .sort((a, b) => {
      const scoreDiff = Number(b.analyst_score) - Number(a.analyst_score);
      if (scoreDiff !== 0) return scoreDiff;
      if (a.created_at !== b.created_at) return b.created_at.localeCompare(a.created_at);
      return b.id.localeCompare(a.id);
    })
    .slice(0, Math.max(0, limit));
  const topUpCandidates = [...heldBest.values()]
    .sort((a, b) => {
      const scoreDiff = Number(b.analyst_score) - Number(a.analyst_score);
      if (scoreDiff !== 0) return scoreDiff;
      if (a.created_at !== b.created_at) return b.created_at.localeCompare(a.created_at);
      return b.id.localeCompare(a.id);
    })
    .slice(0, Math.max(0, options.topUpLimit ?? Number.MAX_SAFE_INTEGER));
  return { selected, topUpCandidates, duplicateIds, excludedIds };
}
