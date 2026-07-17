import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { buildForm4XmlUrl } from "@/lib/data/edgar-insider";
import { symbolsFromLatestLiveSnapshots } from "@/lib/research/holding-symbols";

export const runtime = "nodejs";
// This route makes up to ~56 sequential SEC calls plus a 797KB CIK map and
// paces itself with fair-use sleeps. With no maxDuration it inherited the
// platform default and could be killed mid-scan, which surfaced as a partial
// result indistinguishable from a complete one.
export const maxDuration = 60;

const SEC_UA = "Kairos vterminater@gmail.com";
const LOOKBACK_DAYS = 90;
const MAX_FILINGS_PER_SYMBOL = 6;

interface EdgarTransaction {
  symbol: string;
  name: string;
  role: string;
  securityTitle: string;
  transactionType: "buy" | "sell" | "other";
  shares: number;
  price: number;
  value: number;
  date: string;
  filingDate: string;
  // Days between the trade and the day it became public. Form 4s are due within
  // 2 business days, but the lag varies — a trade dated 8 days ago that only
  // filed yesterday is new information; one that filed 8 days ago is already
  // priced in. Showing only `date` makes those two look identical.
  filingLagDays: number;
  accessionNumber: string;
}

// Per-symbol scan outcome. Keeping failures alongside rows is what lets the
// response distinguish "this issuer had no open-market trades" from "we could
// not read this issuer's filings" — previously both were `[]`.
interface SymbolScan {
  symbol: string;
  transactions: EdgarTransaction[];
  filingsScanned: number;
  fetchFailures: number;
  ok: boolean;
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, Math.round((to - from) / 86400_000));
}

let tickerCikCache: Map<string, string> | null = null;
let tickerCikFetchedAt = 0;

async function getTickerCikMap(): Promise<Map<string, string>> {
  const now = Date.now();
  if (tickerCikCache && now - tickerCikFetchedAt < 24 * 3600_000) return tickerCikCache;

  const res = await fetch("https://www.sec.gov/files/company_tickers.json", {
    headers: { "User-Agent": SEC_UA },
    next: { revalidate: 86400 },
  });
  if (!res.ok) throw new Error(`CIK map fetch failed: ${res.status}`);
  const json = await res.json();
  const map = new Map<string, string>();
  for (const entry of Object.values(json) as any[]) {
    if (entry.ticker) {
      map.set(String(entry.ticker).toUpperCase(), String(entry.cik_str).padStart(10, "0"));
    }
  }
  tickerCikCache = map;
  tickerCikFetchedAt = now;
  return map;
}

// Removed `extractXmlValue`/`extractText` (2026-07-16): both were dead — defined,
// never called (parseForm4Xml inlines its own matches). `extractText` was also
// broken: `.replace("tag", tag)` rewrote the FIRST literal "tag" in the pattern,
// producing a regex that could never match its own closing tag. Deleting it so
// it can't be picked up later as if it worked.
function parseForm4Xml(xml: string, symbol: string, filingDate: string, accNo: string): EdgarTransaction[] {
  const results: EdgarTransaction[] = [];

  const nameMatch = xml.match(/<rptOwnerName>\s*([^<]+)\s*<\/rptOwnerName>/i);
  const name = nameMatch?.[1]?.trim() ?? "Unknown";

  const isDirector = /<isDirector>\s*1\s*<\/isDirector>/i.test(xml);
  const isOfficer = /<isOfficer>\s*1\s*<\/isOfficer>/i.test(xml);
  const is10Pct = /<isTenPercentOwner>\s*1\s*<\/isTenPercentOwner>/i.test(xml);
  const titleMatch = xml.match(/<officerTitle>\s*([^<]+)\s*<\/officerTitle>/i);
  const officerTitle = titleMatch?.[1]?.trim() ?? "";

  const role = isOfficer ? (officerTitle || "Officer") : isDirector ? "Director" : is10Pct ? "10% Owner" : "Insider";

  const nonDerivBlocks = [...xml.matchAll(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/gi)];
  for (const m of nonDerivBlocks) {
    const block = m[1];

    const secTitle = block.match(/<securityTitle>[\s\S]*?<value>([^<]*)<\/value>/i)?.[1]?.trim() ?? "Common Stock";
    const date = block.match(/<transactionDate>[\s\S]*?<value>([^<]*)<\/value>/i)?.[1]?.trim() ?? filingDate;
    const sharesRaw = block.match(/<transactionShares>[\s\S]*?<value>([^<]*)<\/value>/i)?.[1]?.trim() ?? "0";
    const priceRaw = block.match(/<transactionPricePerShare>[\s\S]*?<value>([^<]*)<\/value>/i)?.[1]?.trim() ?? "0";
    const transactionCode = block.match(/<transactionCode>\s*([A-Z])\s*<\/transactionCode>/i)?.[1]?.trim().toUpperCase() ?? "";

    const shares = parseFloat(sharesRaw) || 0;
    const price = parseFloat(priceRaw) || 0;
    if (shares <= 0) continue;

    results.push({
      symbol,
      name,
      role,
      securityTitle: secTitle,
      // Only P/S are open-market conviction trades. Acquired/disposed codes
      // misclassify awards, gifts, exercises, and tax withholding as buys/sells.
      transactionType: transactionCode === "P" ? "buy" : transactionCode === "S" ? "sell" : "other",
      shares,
      price,
      value: shares * price,
      date,
      filingDate,
      filingLagDays: daysBetween(date, filingDate),
      accessionNumber: accNo,
    });
  }

  return results;
}

async function fetchForm4sForSymbol(
  symbol: string,
  cikPadded: string
): Promise<SymbolScan> {
  const subRes = await fetch(
    `https://data.sec.gov/submissions/CIK${cikPadded}.json`,
    { headers: { "User-Agent": SEC_UA }, next: { revalidate: 3600 } }
  );
  // Index fetch failed — we know nothing about this issuer. Do not let that
  // return an empty array that the UI renders as "no insider trades".
  if (!subRes.ok) {
    return { symbol, transactions: [], filingsScanned: 0, fetchFailures: 1, ok: false };
  }

  const sub = await subRes.json();
  const recent = sub.filings?.recent ?? {};
  const forms: string[] = recent.form ?? [];
  const dates: string[] = recent.filingDate ?? [];
  const accNos: string[] = recent.accessionNumber ?? [];
  const primaryDocs: string[] = recent.primaryDocument ?? [];

  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86400_000)
    .toISOString()
    .slice(0, 10);

  const indices = forms
    .map((f: string, i: number) => ({ f, i }))
    .filter(({ f, i }: { f: string; i: number }) => f === "4" && dates[i] >= cutoff)
    .slice(0, MAX_FILINGS_PER_SYMBOL)
    .map(({ i }: { i: number }) => i);

  const results: EdgarTransaction[] = [];
  let filingsScanned = 0;
  let fetchFailures = 0;

  for (const idx of indices) {
    const accDash = accNos[idx];
    const filingDate = dates[idx];
    // Resolve the real machine-readable XML from primaryDocument. See
    // lib/data/edgar-insider.ts for why `<accession>.xml` never existed and why
    // the xsl-prefixed path must not be used (it serves HTML).
    const xmlUrl = buildForm4XmlUrl(cikPadded, accDash, primaryDocs[idx]);
    if (!xmlUrl) continue; // no XML primary document — nothing to parse

    filingsScanned++;
    try {
      const xmlRes = await fetch(xmlUrl, {
        headers: { "User-Agent": SEC_UA },
      });
      if (!xmlRes.ok) { fetchFailures++; continue; }
      const xml = await xmlRes.text();
      results.push(...parseForm4Xml(xml, symbol, filingDate, accDash));
    } catch {
      fetchFailures++;
      continue;
    }

    // SEC rate limit: ~10 req/sec; small sleep between XML fetches
    await new Promise((r) => setTimeout(r, 120));
  }

  return {
    symbol,
    transactions: results,
    filingsScanned,
    fetchFailures,
    ok: fetchFailures === 0,
  };
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    let symbolsParam = url.searchParams.get("symbols") ?? "";

    // If no symbols provided, pull from held positions + active watchlist.
    //
    // BUGS (fixed 2026-07-16), both of which silently shrank this universe:
    //  1. `agent_watchlist` DOES NOT EXIST — the table is `watchlist`. supabase-js
    //     returns that in `error`, not by throwing, so `(watchlist ?? [])` made
    //     half the universe vanish without a trace. `watchlist` also has no
    //     `is_active` column (it uses `expires_at`), so a bare rename would have
    //     kept it broken — the filter now mirrors lib/research-agent.ts.
    //  2. `.limit(1).single()` ordered by captured_at took ONE of seven broker
    //     accounts. All seven are captured in the same batch, so the winner came
    //     down to a ~294ms tiebreak (Webull), and the Agentic/Trading accounts
    //     contributed nothing. Union every account's latest snapshot instead,
    //     matching fetchHoldings() in lib/research-agent.ts.
    if (!symbolsParam) {
      const svc = createServiceClient();
      const nowIso = new Date().toISOString();
      const [snapshots, watchlist] = await Promise.all([
        svc
          .from("live_account_snapshots")
          .select("account_id, broker, positions_json, captured_at")
          .order("captured_at", { ascending: false })
          .limit(100),
        svc
          .from("watchlist")
          .select("symbol")
          .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
          .limit(12),
      ]);

      // PostgREST reports failure in `error`. Surfacing it is the whole point:
      // a dead universe query must not look like an empty market.
      if (snapshots.error) {
        throw new Error(`live_account_snapshots read failed: ${snapshots.error.message ?? snapshots.error}`);
      }
      if (watchlist.error) {
        throw new Error(`watchlist read failed: ${watchlist.error.message ?? watchlist.error}`);
      }

      const heldSymbols = symbolsFromLatestLiveSnapshots(snapshots.data ?? []);
      const watchSymbols = (watchlist.data ?? []).map((w: any) =>
        String(w.symbol).toUpperCase()
      );
      const allSymbols = [
        ...new Set([...heldSymbols, ...watchSymbols]),
      ].slice(0, 8);

      symbolsParam = allSymbols.join(",");
    }

    const symbols = symbolsParam
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 8);

    if (symbols.length === 0) {
      return NextResponse.json({ transactions: [], symbols: [] });
    }

    const cikMap = await getTickerCikMap();

    const allTx: EdgarTransaction[] = [];
    const scanned: string[] = [];
    const unresolved: string[] = []; // no SEC CIK (non-US/ADR) — not a failure
    const failed: string[] = [];     // filings existed but could not be read
    let filingsScanned = 0;

    for (const symbol of symbols) {
      const cik = cikMap.get(symbol);
      if (!cik) { unresolved.push(symbol); continue; }
      const scan = await fetchForm4sForSymbol(symbol, cik);
      allTx.push(...scan.transactions);
      filingsScanned += scan.filingsScanned;
      scanned.push(symbol);
      if (!scan.ok) failed.push(symbol);
      // pace between symbols
      await new Promise((r) => setTimeout(r, 200));
    }

    allTx.sort((a, b) => b.date.localeCompare(a.date));

    // Why the list may be empty — the UI must be able to say which of these it
    // is instead of asserting "no recent insider trades found" over a failure.
    // `complete`: we read every filing we meant to read; an empty list is a real
    // finding ("no open-market P/S trades in the last N filings"), because most
    // Form 4 activity is awards/exercises/withholding (A/M/F/G), not P/S.
    const status = failed.length === 0
      ? "complete"
      : failed.length === scanned.length && scanned.length > 0
        ? "failed"
        : "partial";

    return NextResponse.json({
      transactions: allTx,
      symbols,
      count: allTx.length,
      buys: allTx.filter((t) => t.transactionType === "buy").length,
      sells: allTx.filter((t) => t.transactionType === "sell").length,
      // Coverage//honesty contract for the empty state (see MarketsPage handoff).
      status,
      coverage: {
        requested: symbols.length,
        scanned: scanned.length,
        unresolved,
        failed,
        filingsScanned,
        maxFilingsPerSymbol: MAX_FILINGS_PER_SYMBOL,
        lookbackDays: LOOKBACK_DAYS,
      },
      fetchedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
