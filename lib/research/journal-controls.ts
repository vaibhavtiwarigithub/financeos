export const JOURNAL_ALL_DATES_LIMIT = 250;
export const SCORE_TRACKER_MAX_SYMBOLS = 50;

export function normalizeJournalSymbol(raw: string | null | undefined): string | null {
  const symbol = String(raw ?? "").trim().toUpperCase();
  if (!symbol) return null;
  return /^[A-Z0-9^&.-]{1,24}$/.test(symbol) ? symbol : null;
}

export function chunkScoreTrackerSymbols(symbols: string[]): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < symbols.length; i += SCORE_TRACKER_MAX_SYMBOLS) {
    chunks.push(symbols.slice(i, i + SCORE_TRACKER_MAX_SYMBOLS));
  }
  return chunks;
}

export function applyScoreTrackerSelection(
  current: string[],
  matches: string[],
  mode: "replace" | "add" | "clear",
): string[] {
  if (mode === "clear") return [];
  const next = mode === "replace" ? matches : Array.from(new Set([...current, ...matches]));
  return next.slice(0, SCORE_TRACKER_MAX_SYMBOLS);
}
