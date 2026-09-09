import { createHash } from "crypto";

const SEC_USER_AGENT = "Kairos vterminater@gmail.com";
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

/** Parse the SEC master-index body without treating a failed/changed page as zero filings. */
export function parseEdgarMasterIndex(body: string): EdgarListingFiling[] {
  const header = "CIK|Company Name|Form Type|Date Filed|Filename";
  const headerAt = body.indexOf(header);
  if (headerAt < 0) throw new Error("SEC daily master index is missing its column header");
  const rows: EdgarListingFiling[] = [];
  for (const line of body.slice(headerAt + header.length).split(/\r?\n/)) {
    const [rawCik, rawName, rawForm, rawDate, filename] = line.trim().split("|");
    const form = String(rawForm ?? "").toUpperCase();
    if (!rawCik || !rawName || !rawDate || !filename || !IPO_FORMS.has(form)) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) continue;
    const cik = rawCik.padStart(10, "0");
    const accessionNumber = filename.match(/(\d{10}-\d{2}-\d{6})\.txt$/)?.[1];
    if (!accessionNumber) continue;
    const sourceUrl = `https://www.sec.gov/Archives/${filename}`;
    const canonical = [cik, rawName.trim(), form, rawDate, filename].join("|");
    rows.push({ cik, companyName: rawName.trim(), form, filedAt: rawDate, accessionNumber, sourceUrl,
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
      headers: { "User-Agent": SEC_USER_AGENT, Accept: "text/plain" }, cache: "no-store", signal: timeout,
    });
  } catch (error) {
    // A transport timeout is unavailable evidence, never an empty filing day.
    throw new Error(`SEC daily master index request failed: ${error instanceof Error ? error.name : "transport_error"}`);
  }
  if (res.status === 404) return []; // non-filing day; caller retains the distinction in its run record.
  if (!res.ok) throw new Error(`SEC daily master index fetch failed: ${res.status}`);
  return parseEdgarMasterIndex(await res.text());
}

export function isFilingDay(date: Date): boolean {
  const day = date.getUTCDay();
  return day !== 0 && day !== 6;
}
