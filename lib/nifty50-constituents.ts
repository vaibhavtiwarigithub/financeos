const NIFTY50_CSV_URL = "https://www.niftyindices.com/IndexConstituent/ind_nifty50list.csv";
const NIFTY50_CACHE_MS = 24 * 60 * 60 * 1000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";
let cached: { symbols: string[]; at: number } | null = null;

function parseCsvRow(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }
  if (quoted) return [];
  cells.push(cell.trim());
  return cells;
}

/** Parse the official NSE Indices NIFTY-50 constituent CSV fail-closed. */
export function parseNiftyConstituentsCsv(text: string, minCount: number, maxCount = minCount): string[] | null {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim().length > 0);
  const header = lines[0] ? parseCsvRow(lines[0]).map((cell) => cell.trim().toUpperCase()) : [];
  const symbolIndex = header.indexOf("SYMBOL");
  const seriesIndex = header.indexOf("SERIES");
  if (symbolIndex < 0 || seriesIndex < 0) return null;

  const symbols: string[] = [];
  for (const line of lines.slice(1)) {
    const cells = parseCsvRow(line);
    if (cells.length <= Math.max(symbolIndex, seriesIndex)) return null;
    const symbol = cells[symbolIndex].trim().toUpperCase();
    const series = cells[seriesIndex].trim().toUpperCase();
    if (!symbol || !/^[A-Z0-9&_-]+$/.test(symbol)) return null;
    if (series === "EQ") symbols.push(`${symbol}.NS`);
  }

  const unique = [...new Set(symbols)];
  // Exactly 50 unique EQ rows rejects duplicate rows, block pages and partial files.
  return unique.length >= minCount && unique.length <= maxCount && symbols.length === unique.length ? unique : null;
}

export function parseNifty50ConstituentsCsv(text: string): string[] | null {
  return parseNiftyConstituentsCsv(text, 50);
}

/**
 * Current NIFTY-50 membership from NSE Indices' public CSV, cached for one day.
 * Null means the source could not be verified; callers must visibly report any
 * static fallback rather than silently treating it as current.
 */
export async function fetchNifty50Constituents(): Promise<string[] | null> {
  if (cached && Date.now() - cached.at < NIFTY50_CACHE_MS) return [...cached.symbols];
  try {
    const response = await fetch(NIFTY50_CSV_URL, {
      headers: { "User-Agent": UA, Accept: "text/csv,application/octet-stream,*/*" },
      next: { revalidate: 86400 },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    const symbols = parseNifty50ConstituentsCsv(await response.text());
    if (!symbols) return null;
    cached = { symbols, at: Date.now() };
    return [...symbols];
  } catch {
    return null;
  }
}
