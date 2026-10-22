import { latestEntryAssessments } from "@/lib/trading/fresh-entry-signals";

export interface PaperSignalCandidate {
  id: string;
  symbol: string;
  market?: string | null;
  asset_class?: string | null;
  analyst_score: number | string | null;
  created_at: string;
}

/** Generic equity PaperTrader must never consume the dedicated crypto cohort. */
export function isCryptoPaperSignal(signal: Pick<PaperSignalCandidate, "symbol" | "asset_class">): boolean {
  const assetClass = String(signal.asset_class ?? "").trim().toLowerCase();
  const symbol = String(signal.symbol ?? "").trim().toUpperCase();
  return assetClass === "crypto" || /^[A-Z0-9]+-USD$/.test(symbol);
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

  const marketRows = rows.filter(row => !isCryptoPaperSignal(row) && candidateMarket(row) === market);
  const latestIds = new Set(latestEntryAssessments(marketRows).map(row => row.id));
  for (const row of marketRows) {
    if (isCryptoPaperSignal(row)) continue;
    if (candidateMarket(row) !== market) continue;
    const symbol = String(row.symbol ?? "").trim().toUpperCase();
    if (!symbol) continue;
    if (options.excludedSymbols?.has(symbol)) {
      excludedIds.push(row.id);
      continue;
    }
    if (!latestIds.has(row.id)) { duplicateIds.push(row.id); continue; }
    const target = options.heldSymbols?.has(symbol) ? heldBest : best;
    target.set(symbol, row);
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
