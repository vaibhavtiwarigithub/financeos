import { createHash } from "crypto";

// SEC's published sample identifies both the application and its contact.
export const SEC_USER_AGENT = "Kairos Research (contact: vterminater@gmail.com)";
const IPO_FORMS = new Set(["S-1", "S-1/A", "F-1", "F-1/A", "424B4"]);

export type EdgarListingFiling = {
  cik: string;
  companyName: string;
  form: string;
  filedAt: string;
  accessionNumber: string;
  sourceUrl: string;
  payloadHash: string;
};

export type SecCurrentIssuerListing = { cik: string; companyName: string; symbol: string; exchange: string };

/** SEC's current issuer/ticker map resolves identity, but is not a listing-event feed. */
export function parseSecCurrentIssuerListings(payload: unknown): SecCurrentIssuerListing[] {
  if (!payload || typeof payload !== "object") throw new Error("SEC issuer ticker map has invalid shape");
  const root = payload as { fields?: unknown; data?: unknown };
  if (!Array.isArray(root.fields) || !Array.isArray(root.data)) throw new Error("SEC issuer ticker map is missing fields/data");
  const fields = root.fields.map(value => String(value).trim().toLowerCase());
  const indices = { cik: fields.indexOf("cik"), name: fields.indexOf("name"), ticker: fields.indexOf("ticker"), exchange: fields.indexOf("exchange") };
  if (Object.values(indices).some(index => index < 0)) throw new Error("SEC issuer ticker map is missing expected columns");
  const rows: SecCurrentIssuerListing[] = [];
  for (const raw of root.data) {
    if (!Array.isArray(raw)) continue;
    const cikRaw = String(raw[indices.cik] ?? "").trim();
    const companyName = String(raw[indices.name] ?? "").trim();
    const symbol = String(raw[indices.ticker] ?? "").trim().toUpperCase();
    const exchange = String(raw[indices.exchange] ?? "").trim();
    if (!/^\d{1,10}$/.test(cikRaw) || !companyName || !/^[A-Z0-9.\-/]{1,16}$/.test(symbol) || !exchange) continue;
    rows.push({ cik: cikRaw.padStart(10, "0"), companyName, symbol, exchange });
  }
  return rows;
}

export async function fetchSecCurrentIssuerListings(): Promise<SecCurrentIssuerListing[]> {
  let response: Response;
  try {
    response = await fetch("https://www.sec.gov/files/company_tickers_exchange.json", {
      headers: { "User-Agent": SEC_USER_AGENT, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    throw new Error(`SEC issuer ticker map request failed: ${error instanceof Error ? error.name : "transport_error"}`);
  }
  if (!response.ok) throw new Error(`SEC issuer ticker map fetch failed: ${response.status}`);
  return parseSecCurrentIssuerListings(await response.json());
}

/** Parse the SEC master-index body without treating a failed/changed page as zero filings. */
export function parseEdgarMasterIndex(body: string): EdgarListingFiling[] {
  // Confirmed against a real live fetch 2026-09-24: SEC's actual header has a
  // space in "File Name", not "Filename" as this constant previously read.
  // That one-character mismatch meant indexOf() never matched, so this threw
  // "missing its column header" on every run for weeks regardless of the
  // real data being perfectly valid -- the test fixture below had the same
  // wrong header baked in, so tests passed while being wrong the whole time.
  const header = "CIK|Company Name|Form Type|Date Filed|File Name";
  const headerAt = body.indexOf(header);
  if (headerAt < 0) throw new Error("SEC daily master index is missing its column header");
  const rows: EdgarListingFiling[] = [];
  for (const line of body.slice(headerAt + header.length).split(/\r?\n/)) {
    const [rawCik, rawName, rawForm, rawDate, filename] = line.trim().split("|");
    const form = String(rawForm ?? "").toUpperCase();
    if (!rawCik || !rawName || !rawDate || !filename || !IPO_FORMS.has(form)) continue;
    // The real SEC daily index writes dates as YYYYMMDD ("20260930"). The parser only accepted ISO dates, so it
    // dropped EVERY row (a real 2026-09-30 index holds 12 S-1/F-1/424B4 filings; the run reported filing_count 0
    // with status "available" for every day since the header fix, and listing_candidates never got a row). The test
    // fixture used ISO dates, which is why tests never caught it. Normalize to ISO.
    const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(rawDate.trim());
    const filedAt = compact ? `${compact[1]}-${compact[2]}-${compact[3]}` : /^\d{4}-\d{2}-\d{2}$/.test(rawDate.trim()) ? rawDate.trim() : null;
    if (!filedAt) continue;
    const cik = rawCik.padStart(10, "0");
    const accessionNumber = filename.match(/(\d{10}-\d{2}-\d{6})\.txt$/)?.[1];
    if (!accessionNumber) continue;
    const sourceUrl = `https://www.sec.gov/Archives/${filename}`;
    const canonical = [cik, rawName.trim(), form, rawDate, filename].join("|");
    rows.push({ cik, companyName: rawName.trim(), form, filedAt, accessionNumber, sourceUrl,
      payloadHash: createHash("sha256").update(canonical).digest("hex") });
  }
  return rows;
}

export function edgarDailyIndexUrl(date: Date): string {
  const year = date.getUTCFullYear();
  const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
  const ymd = date.toISOString().slice(0, 10).replaceAll("-", "");
  return `https://www.sec.gov/Archives/edgar/daily-index/${year}/QTR${quarter}/master.${ymd}.idx`;
}

export async function fetchEdgarListingFilings(date: Date): Promise<EdgarListingFiling[]> {
  const timeout = AbortSignal.timeout(12_000);
  let res: Response;
  try {
    res = await fetch(edgarDailyIndexUrl(date), {
      headers: { "User-Agent": SEC_USER_AGENT, Accept: "text/plain", "Accept-Encoding": "gzip, deflate" }, cache: "no-store", signal: timeout,
    });
  } catch (error) {
    // A transport timeout is unavailable evidence, never an empty filing day.
    throw new Error(`SEC daily master index request failed: ${error instanceof Error ? error.name : "transport_error"}`);
  }
  // A missing index is unavailable evidence, not proof of zero filings.
  if (!res.ok) {
    // Keep only safe response metadata that helps separate a bad user-agent
    // from an upstream edge/IP denial; never retain cookies or body text.
    const trace = ["cf-ray", "x-amz-cf-id", "x-amzn-requestid", "x-request-id"]
      .map(name => { const value = res.headers.get(name)?.replace(/[^a-zA-Z0-9._:/=-]/g, "").slice(0, 128); return value ? `${name}=${value}` : null; })
      .filter(Boolean).join(",");
    const server = res.headers.get("server")?.replace(/[^a-zA-Z0-9._/-]/g, "").slice(0, 64);
    throw new Error(`SEC daily master index fetch failed: ${res.status}${server ? ` server=${server}` : ""}${trace ? ` ${trace}` : ""}`);
  }
  return parseEdgarMasterIndex(await res.text());
}

export function isFilingDay(date: Date): boolean {
  const day = date.getUTCDay();
  return day !== 0 && day !== 6;
}

/** SEC builds daily indexes starting around 22:00 ET and can take hours.
 * Use the previous ET date after 03:00 ET, and the date before that earlier.
 * Weekdays are candidates, not a claim about SEC holiday publication.
 */
export function publishedEdgarIndexDates(now = new Date(), count = 3): Date[] {
  if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error("invalid SEC index lookback");
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const part = (type: string) => Number(parts.find(p => p.type === type)?.value);
  const last = Date.UTC(part("year"), part("month") - 1, part("day") - (part("hour") >= 3 ? 1 : 2));
  const dates: Date[] = [];
  for (let offset = 0; dates.length < count; offset++) {
    const date = new Date(last - offset * 86400000);
    if (isFilingDay(date)) dates.push(date);
  }
  return dates;
}

export async function collectEdgarIndexes(now = new Date(), fetchIndex = fetchEdgarListingFilings) {
  const batches: Array<{ date: string; status: "available" | "unavailable"; filings: EdgarListingFiling[]; error?: string }> = [];
  // Three bounded requests, sequentially: no failure discards other valid days.
  for (const date of publishedEdgarIndexDates(now)) {
    try { batches.push({ date: date.toISOString().slice(0, 10), status: "available", filings: await fetchIndex(date) }); }
    catch (error) { batches.push({ date: date.toISOString().slice(0, 10), status: "unavailable", filings: [], error: error instanceof Error ? error.message : "SEC index unavailable" }); }
  }
  return batches;
}
