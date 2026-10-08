import { createHash } from "crypto";

export const NASDAQ_LISTED_URL = "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt";
export const OTHER_LISTED_URL = "https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt";
export const US_SYMBOL_DIRECTORY_SOURCE = "nasdaq_trader_symbol_directory";

export type DirectoryCandidate = {
  listingKey: string;
  symbol: string;
  companyName: string;
  exchange: string;
  exchangeCode: string;
  instrumentType: "operating_company" | "adr" | "etf";
  payloadHash: string;
};

export type ParsedSymbolDirectory = {
  sourceAsOf: string;
  listingKeys: string[];
  sourceHash: string;
  researchable: DirectoryCandidate[];
  totalRows: number;
  excludedRows: number;
  nasdaqRows: number;
  otherRows: number;
};

const EXCHANGES: Record<string, string> = {
  A: "NYSE American", F: "TXSE", M: "NYSE Texas", N: "NYSE", P: "NYSE Arca", V: "Investors Exchange", Z: "Cboe BZX", Q: "Nasdaq",
};
const SYMBOL = /^[A-Z0-9][A-Z0-9.-]{0,9}$/;
const EXCLUDED_NAME = /\b(WARRANTS?|RIGHTS?|UNITS?|PREFERRED|DEBENTURE|NOTE\s+DUE|BOND|ETN|EXCHANGE-TRADED NOTES?|CLOSED[- ]END FUNDS?)\b/i;
const ADR_NAME = /\b(ADR|ADS|AMERICAN DEPOSITARY|AMERICAN DEPOSITORY|DEPOSITARY (RECEIPTS?|SHARES?))\b/i;
const COMMON_EQUITY_NAME = /\b(COMMON STOCK|COMMON SHARES?|ORDINARY SHARES?)\b/i;

function sha256(value: string) { return createHash("sha256").update(value).digest("hex"); }

function parseFooterDate(body: string): string {
  const match = /File Creation Time:\s*(\d{2})(\d{2})(\d{4})\d{2}:\d{2}/i.exec(body);
  if (!match) throw new Error("Nasdaq symbol directory is missing a valid File Creation Time footer");
  const [, month, day, year] = match;
  const date = `${year}-${month}-${day}`;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new Error("Nasdaq symbol directory footer date is invalid");
  return date;
}

function rowsFor(body: string, kind: "nasdaq" | "other") {
  const lines = body.replace(/^\uFEFF/, "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const headers = lines[0]?.split("|").map(value => value.trim());
  const expected = kind === "nasdaq"
    ? ["Symbol", "Security Name", "Market Category", "Test Issue", "Financial Status", "Round Lot Size", "ETF", "NextShares"]
    : ["ACT Symbol", "Security Name", "Exchange", "CQS Symbol", "ETF", "Round Lot Size", "Test Issue", "NASDAQ Symbol"];
  if (!headers || headers.length !== expected.length || expected.some((name, i) => headers[i] !== name)) {
    throw new Error(`${kind} directory header does not match the documented Nasdaq contract`);
  }
  const result: Array<{ symbol: string; name: string; exchangeCode: string; etf: string; testIssue: string }> = [];
  for (const line of lines.slice(1)) {
    if (/^File Creation Time:/i.test(line)) continue;
    const cells = line.split("|");
    if (cells.length !== expected.length) throw new Error(`${kind} directory contains a malformed row`);
    result.push(kind === "nasdaq"
      ? { symbol: cells[0], name: cells[1], exchangeCode: "Q", etf: cells[6], testIssue: cells[3] }
      : { symbol: cells[0], name: cells[1], exchangeCode: cells[2], etf: cells[4], testIssue: cells[6] });
  }
  return result;
}

function candidate(row: { symbol: string; name: string; exchangeCode: string; etf: string; testIssue: string }): DirectoryCandidate | null {
  const symbol = row.symbol.trim().toUpperCase();
  const companyName = row.name.trim();
  const code = row.exchangeCode.trim().toUpperCase();
  if (!SYMBOL.test(symbol) || !companyName || row.testIssue.trim().toUpperCase() === "Y" || !EXCHANGES[code]) return null;
  const isEtf = row.etf.trim().toUpperCase() === "Y";
  const isAdr = ADR_NAME.test(companyName);
  if (!isEtf && (EXCLUDED_NAME.test(companyName) || (!isAdr && !COMMON_EQUITY_NAME.test(companyName)))) return null;
  const instrumentType = isEtf ? "etf" : isAdr ? "adr" : "operating_company";
  const listingKey = `${code}:${symbol}`;
  return { listingKey, symbol, companyName, exchange: EXCHANGES[code], exchangeCode: code, instrumentType,
    payloadHash: sha256([listingKey, companyName, row.etf.trim().toUpperCase()].join("|")) };
}

/**
 * Parses the two official daily Nasdaq Trader symbol-directory files. Directory
 * membership is a discovery observation, not a first-trade or broker-support event.
 */
export function parseUsSymbolDirectory(nasdaqBody: string, otherBody: string, now = new Date()): ParsedSymbolDirectory {
  const nasdaqAsOf = parseFooterDate(nasdaqBody);
  const otherAsOf = parseFooterDate(otherBody);
  if (nasdaqAsOf !== otherAsOf) throw new Error("Nasdaq directory files have mismatched as-of dates");
  const ageMs = now.getTime() - new Date(`${nasdaqAsOf}T00:00:00.000Z`).getTime();
  if (!Number.isFinite(ageMs) || ageMs < -86400000 || ageMs > 7 * 86400000) throw new Error("Nasdaq directory snapshot is outside the 7-day freshness bound");

  const nasdaqRows = rowsFor(nasdaqBody, "nasdaq");
  const otherRows = rowsFor(otherBody, "other");
  if (nasdaqRows.length < 4000 || otherRows.length < 5000) throw new Error("Nasdaq symbol directory coverage is below its validated row-count floor");
  const allRows = [...nasdaqRows, ...otherRows];
  const parsed = allRows.map(candidate);
  const unknownExchanges = new Set(otherRows.map(row => row.exchangeCode.trim().toUpperCase()).filter(code => code && !EXCHANGES[code]));
  if (unknownExchanges.size) throw new Error(`Nasdaq directory contains unsupported exchange codes: ${[...unknownExchanges].sort().join(",")}`);
  const byKey = new Map<string, DirectoryCandidate>();
  for (const value of parsed) if (value) {
    if (byKey.has(value.listingKey)) throw new Error(`Nasdaq directory contains duplicate listing key ${value.listingKey}`);
    byKey.set(value.listingKey, value);
  }
  const listingKeys = [...byKey.keys()].sort();
  const sourceHash = sha256(listingKeys.join("\n"));
  return { sourceAsOf: nasdaqAsOf, listingKeys, sourceHash, researchable: [...byKey.values()],
    totalRows: allRows.length, excludedRows: allRows.length - byKey.size, nasdaqRows: nasdaqRows.length, otherRows: otherRows.length };
}

export async function fetchUsSymbolDirectory(fetcher: typeof fetch = fetch): Promise<ParsedSymbolDirectory> {
  const headers = { "User-Agent": "Kairos Research (contact: vterminater@gmail.com)", Accept: "text/plain" };
  const [nasdaqResponse, otherResponse] = await Promise.all([
    fetcher(NASDAQ_LISTED_URL, { headers, cache: "no-store", signal: AbortSignal.timeout(12_000) }),
    fetcher(OTHER_LISTED_URL, { headers, cache: "no-store", signal: AbortSignal.timeout(12_000) }),
  ]);
  if (!nasdaqResponse.ok || !otherResponse.ok) throw new Error(`Nasdaq directory fetch failed (nasdaqlisted=${nasdaqResponse.status}, otherlisted=${otherResponse.status})`);
  return parseUsSymbolDirectory(await nasdaqResponse.text(), await otherResponse.text());
}
