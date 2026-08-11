export interface PaperSignalCandidate {
  id: string;
  symbol: string;
  market?: string | null;
  asset_class?: string | null;
  analyst_score: number | string | null;
  created_at: string;
}

export interface PaperSignalSelectionOptions {
  /**
   * Symbols already held as alpha positions in this market. They still receive
   * fresh research for PositionMonitor, but cannot consume a paper-entry slot.
   */
  excludedSymbols?: ReadonlySet<string>;
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
): { selected: T[]; duplicateIds: string[]; excludedIds: string[] } {
  const best = new Map<string, T>();
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
    const incumbent = best.get(symbol);
    if (!incumbent) best.set(symbol, row);
    else if (isBetter(row, incumbent)) {
      duplicateIds.push(incumbent.id);
      best.set(symbol, row);
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
  return { selected, duplicateIds, excludedIds };
}
