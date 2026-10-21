import { inflateRawSync } from "node:zlib";
import { XMLParser } from "fast-xml-parser";
import { parseNiftyConstituentsCsv } from "@/lib/nifty50-constituents";
import { expectedNewestSession } from "@/lib/data/completed-candles";
import { expectedMarketSessionsBetween } from "@/lib/trading/market-calendar";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { reportIssue, resolveIssue } from "@/lib/system-health";

export interface ConstituentSnapshot {
  benchmark: string;
  source: string;
  membership: "fund_holdings" | "index_membership_proxy";
  asOf: string;
  observedAt: string;
  symbols: string[];
}

const NSE: Record<string, { file: string; min: number; max: number }> = {
  "^NSEI": { file: "ind_nifty50list.csv", min: 50, max: 50 },
  "NIFTYBEES.NS": { file: "ind_nifty50list.csv", min: 50, max: 50 },
  "ITBEES.NS": { file: "ind_niftyitlist.csv", min: 10, max: 10 },
  "BANKBEES.NS": { file: "ind_niftybanklist.csv", min: 12, max: 20 },
  "JUNIORBEES.NS": { file: "ind_niftynext50list.csv", min: 50, max: 50 },
};
const SPDR = new Set(["SPY", "XLK", "XLF", "XLE", "XLI", "XLV", "XLU", "XLRE", "XLB", "XLC", "XLP", "XLY"]);
const cache = new Map<string, ConstituentSnapshot>();
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, processEntities: false });
const array = <T>(value: T | T[] | undefined): T[] => value == null ? [] : Array.isArray(value) ? value : [value];

/** Only two XML members are read; bounded inflation prevents an oversized ZIP member. */
function workbookXml(bytes: Buffer, name: string): string {
  if (bytes.length > 5_000_000) throw new Error("holdings_workbook_too_large");
  for (let offset = 0; offset + 46 <= bytes.length; offset++) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) continue;
    const length = bytes.readUInt16LE(offset + 28);
    if (bytes.subarray(offset + 46, offset + 46 + length).toString() !== name) continue;
    const method = bytes.readUInt16LE(offset + 10);
    const local = bytes.readUInt32LE(offset + 42);
    if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) break;
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const end = start + bytes.readUInt32LE(offset + 20);
    if (end > bytes.length || bytes.readUInt32LE(offset + 24) > 5_000_000) break;
    const compressed = bytes.subarray(start, end);
    if (method === 0) return compressed.toString();
    if (method === 8) return inflateRawSync(compressed, { maxOutputLength: 5_000_000 }).toString();
    break;
  }
  throw new Error(`holdings_workbook_missing:${name}`);
}

function xmlText(node: any): string {
  if (node == null) return "";
  if (typeof node !== "object") return String(node);
  if (node["#text"] != null) return String(node["#text"]);
  if (node.t != null) return xmlText(node.t);
  return array<any>(node.r).map(xmlText).join("");
}

export function parseSpdrHoldings(bytes: Buffer, expectedTicker?: string): { asOf: string; symbols: string[] } {
  const strings = array<any>(parser.parse(workbookXml(bytes, "xl/sharedStrings.xml")).sst?.si).map(xmlText);
  const rows = array<any>(parser.parse(workbookXml(bytes, "xl/worksheets/sheet1.xml")).worksheet?.sheetData?.row)
    .map(row => array<any>(row.c).map(cell => ({ column: String(cell["@_r"] ?? "").replace(/[0-9]/g, ""),
      value: cell["@_t"] === "s" ? strings[Number(cell.v)] ?? "" : xmlText(cell.v ?? cell.is) })));
  const holdingsRow = rows.find(row => row.some(cell => cell.value === "Holdings:"));
  const fundTicker = rows.find(row => row.some(cell => cell.value === "Ticker Symbol:"))?.[1]?.value;
  if (expectedTicker && fundTicker !== expectedTicker) throw new Error("holdings_fund_mismatch");
  const dateText = holdingsRow?.[1]?.value ?? "";
  const date = new Date(dateText.replace(/^As of\s+/i, ""));
  if (!Number.isFinite(date.getTime())) throw new Error("holdings_date_missing");
  const headerIndex = rows.findIndex(row => row.some(cell => cell.value === "Ticker"));
  const column = rows[headerIndex]?.find(cell => cell.value === "Ticker")?.column;
  if (!column) throw new Error("holdings_ticker_header_missing");
  const symbols = rows.slice(headerIndex + 1).map(row => row.find(cell => cell.column === column)?.value ?? "")
    .filter(symbol => /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol) && symbol !== "USD");
  if (symbols.length < 15 || new Set(symbols).size !== symbols.length) throw new Error("holdings_incomplete_or_duplicate");
  return { asOf: date.toISOString().slice(0, 10), symbols };
}

export function parseInvescoHoldings(raw: any): { asOf: string; symbols: string[] } {
  if (raw?.cusip != null && raw.cusip !== "QQQ") throw new Error("holdings_fund_mismatch");
  const holdings = Array.isArray(raw?.holdings) ? raw.holdings : [];
  if (holdings.length !== Number(raw?.totalNumberOfHoldings)) throw new Error("holdings_count_mismatch");
  const equities = holdings.filter((row: any) => ["COM", "ADR", "DRNY", "REIT"].includes(row.securityTypeCode));
  const symbols = equities.map((row: any) => String(row.ticker ?? ""));
  if (symbols.length < 90 || symbols.some((symbol: string) => !/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol))
    || new Set(symbols).size !== symbols.length || !/^\d{4}-\d{2}-\d{2}$/.test(raw.effectiveDate ?? "")) {
    throw new Error("holdings_invalid_equity_list");
  }
  return { asOf: raw.effectiveDate, symbols };
}

export async function fetchConstituentSnapshot(benchmark: string, now = new Date()): Promise<ConstituentSnapshot | null> {
  const cached = cache.get(benchmark);
  const cachedAge = cached ? now.getTime() - Date.parse(cached.observedAt) : Infinity;
  if (cached && cachedAge >= 0 && cachedAge < 86_400_000) return cached;
  const nse = NSE[benchmark];
  const spdrSymbol = benchmark === "VOO" ? "SPY" : benchmark;
  let source: string;
  let membership: ConstituentSnapshot["membership"] = "fund_holdings";
  if (nse) {
    source = `https://www.niftyindices.com/IndexConstituent/${nse.file}`;
    membership = "index_membership_proxy";
  } else if (SPDR.has(spdrSymbol)) {
    source = `https://www.ssga.com/library-content/products/fund-data/etfs/us/holdings-daily-us-en-${spdrSymbol.toLowerCase()}.xlsx`;
    if (benchmark === "VOO") membership = "index_membership_proxy";
  } else if (benchmark === "QQQ") {
    source = "https://dng-api.invesco.com/cache/v1/accounts/en_US/shareclasses/QQQ/holdings/fund?idType=ticker&interval=monthly&productType=ETF";
  } else return null;
  const response = await fetch(source, { signal: AbortSignal.timeout(8_000), next: { revalidate: 86400 } });
  if (!response.ok) throw new Error(`holdings_http_${response.status}`);
  let parsed: { asOf: string; symbols: string[] };
  if (nse) {
    const symbols = parseNiftyConstituentsCsv(await response.text(), nse.min, nse.max);
    if (!symbols) throw new Error("holdings_csv_invalid");
    // NSE's current CSV has no effective-date column. This is an observed-current
    // membership snapshot, never historical membership or actual ETF weights.
    parsed = { asOf: now.toISOString().slice(0, 10), symbols };
  } else parsed = benchmark === "QQQ" ? parseInvescoHoldings(await response.json())
    : parseSpdrHoldings(Buffer.from(await response.arrayBuffer()), spdrSymbol);
  if (spdrSymbol === "SPY" && parsed.symbols.length < 450) throw new Error("sp500_membership_incomplete");
  const age = now.getTime() - Date.parse(parsed.asOf);
  if (!Number.isFinite(age) || age < 0 || age > 10 * 86_400_000) throw new Error("holdings_date_stale_or_future");
  const result = { benchmark, source, membership, ...parsed, observedAt: now.toISOString() };
  cache.set(benchmark, result);
  return result;
}

export interface BenchmarkCoverageCandidate {
  symbol: string;
  context: { benchmark: string; membership: ConstituentSnapshot["membership"]; source: string; as_of: string;
    observed_at: string; completed_session: string; benchmark_return_5_sessions: number | null };
}

/** Require every close in the exact five-session window; six available prices
 * with an interior hole are not a five-session return. */
export function constituentBenchmarkReturn(market: "us" | "india", prices: Map<string, number>, completedSession: string): number | null {
  const start = new Date(`${completedSession}T12:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 30);
  const sessions = expectedMarketSessionsBetween(market, start.toISOString().slice(0, 10), completedSession).slice(-6);
  if (sessions.length !== 6 || sessions.some(date => !Number.isFinite(prices.get(date)) || Number(prices.get(date)) <= 0)) return null;
  return prices.get(sessions[5])! / prices.get(sessions[0])! - 1;
}

/** Round-robin across benchmark baskets, with the strongest completed-session
 * sector first. Oldest-scored-first within each basket keeps names circulating.
 * A leading ETF causes research only; none of these facts alter a stock score. */
export function rankConstituentCoverage(snapshots: ConstituentSnapshot[], lastScores: Map<string, string>,
  returns: Map<string, number>, completedSession: string): BenchmarkCoverageCandidate[] {
  const baskets = [...snapshots].sort((a, b) => (returns.get(b.benchmark) ?? -Infinity) - (returns.get(a.benchmark) ?? -Infinity)
    || a.benchmark.localeCompare(b.benchmark)).map(snapshot => ({ snapshot,
    symbols: [...snapshot.symbols].sort((a, b) => (lastScores.get(a) ?? "").localeCompare(lastScores.get(b) ?? "") || a.localeCompare(b)) }));
  const result: BenchmarkCoverageCandidate[] = [];
  const seen = new Set<string>();
  const add = (snapshot: ConstituentSnapshot, symbol: string | undefined) => {
    if (!symbol || seen.has(symbol)) return;
    seen.add(symbol);
    result.push({ symbol, context: { benchmark: snapshot.benchmark, membership: snapshot.membership, source: snapshot.source,
      as_of: snapshot.asOf, observed_at: snapshot.observedAt, completed_session: completedSession,
      benchmark_return_5_sessions: returns.get(snapshot.benchmark) ?? null } });
  };
  // Two stale constituents from a measured leading basket get a short refresh
  // burst; then round-robin preserves coverage of every other benchmark.
  const leader = baskets[0];
  if (leader && returns.has(leader.snapshot.benchmark)) for (const symbol of leader.symbols
    .filter(symbol => (lastScores.get(symbol) ?? "").slice(0, 10) < completedSession).slice(0, 2)) add(leader.snapshot, symbol);
  for (let i = 0; baskets.some(b => i < b.symbols.length); i++) for (const { snapshot, symbols } of baskets) {
    add(snapshot, symbols[i]);
  }
  return result;
}

export async function benchmarkConstituentCandidates(supabase: any, market: "us" | "india"): Promise<BenchmarkCoverageCandidate[]> {
  const { data, error } = await supabase.from("benchmarks").select("symbol").eq("market", market).eq("enabled", true);
  if (error) throw new Error(`benchmark_membership_registry:${error.message}`);
  const results = await Promise.all((data ?? []).map(async (row: any) => {
    const key = `benchmark-constituents:${market}:${row.symbol}`;
    try {
      const snapshot = await fetchConstituentSnapshot(row.symbol);
      if (!snapshot) throw new Error("membership_source_not_supported");
      await resolveIssue(key, supabase).catch(() => {});
      return snapshot;
    } catch (error) {
      await reportIssue({ issueKey: key, severity: "warn", category: "data", title: `${row.symbol} constituent research coverage unavailable`,
        detail: `${error instanceof Error ? error.message : String(error)}. Benchmark prices alone do not provide constituent research coverage.` }, supabase).catch(() => {});
      return null;
    }
  }));
  const snapshots = results.filter((row): row is ConstituentSnapshot => row != null);
  if (!snapshots.length) return [];
  const cutoff = new Date(Date.now() - 40 * 86_400_000).toISOString();
  const signals = await fetchAllRows<any>((from, to) => supabase.from("agent_signals").select("symbol,created_at")
    .eq("market", market).eq("session_validated", true).gte("created_at", cutoff).lte("created_at", new Date().toISOString())
    .order("created_at", { ascending: false }).order("id", { ascending: false }).range(from, to), "benchmark constituent score recency");
  const lastScores = new Map<string, string>();
  for (const row of signals) if (!lastScores.has(row.symbol)) lastScores.set(row.symbol, row.created_at);
  const completed = expectedNewestSession(market);
  const { data: bars, error: barsError } = await supabase.from("benchmark_price_observations").select("component_symbol,date,close")
    .in("component_symbol", snapshots.map(row => row.benchmark)).gte("date", cutoff.slice(0, 10)).lte("date", completed).order("date", { ascending: false });
  if (barsError) throw new Error(`benchmark_constituent_leadership:${barsError.message}`);
  const returns = new Map<string, number>();
  for (const snapshot of snapshots) {
    const prices = new Map<string, number>((bars ?? []).filter((bar: any) => bar.component_symbol === snapshot.benchmark && Number(bar.close) > 0)
      .map((bar: any) => [String(bar.date), Number(bar.close)] as [string, number]));
    const measured = constituentBenchmarkReturn(market, prices, completed);
    if (measured != null) returns.set(snapshot.benchmark, measured);
  }
  return rankConstituentCoverage(snapshots, lastScores, returns, completed);
}
