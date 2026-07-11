import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

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
  accessionNumber: string;
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

function extractXmlValue(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}>[\\s\\S]*?<value>([^<]*)<\\/value>`, "i"));
  return m?.[1]?.trim() ?? "";
}

function extractText(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)<\\/tag>`.replace("tag", tag), "i"));
  return m?.[1]?.trim() ?? "";
}

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
      accessionNumber: accNo,
    });
  }

  return results;
}

async function fetchForm4sForSymbol(
  symbol: string,
  cikPadded: string
): Promise<EdgarTransaction[]> {
  const cikNum = parseInt(cikPadded, 10);

  const subRes = await fetch(
    `https://data.sec.gov/submissions/CIK${cikPadded}.json`,
    { headers: { "User-Agent": SEC_UA }, next: { revalidate: 3600 } }
  );
  if (!subRes.ok) return [];

  const sub = await subRes.json();
  const recent = sub.filings?.recent ?? {};
  const forms: string[] = recent.form ?? [];
  const dates: string[] = recent.filingDate ?? [];
  const accNos: string[] = recent.accessionNumber ?? [];

  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86400_000)
    .toISOString()
    .slice(0, 10);

  const indices = forms
    .map((f: string, i: number) => ({ f, i }))
    .filter(({ f, i }: { f: string; i: number }) => f === "4" && dates[i] >= cutoff)
    .slice(0, MAX_FILINGS_PER_SYMBOL)
    .map(({ i }: { i: number }) => i);

  const results: EdgarTransaction[] = [];

  for (const idx of indices) {
    const accDash = accNos[idx];
    const accFlat = accDash.replace(/-/g, "");
    const filingDate = dates[idx];

    try {
      const xmlUrl = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accFlat}/${accDash}.xml`;
      const xmlRes = await fetch(xmlUrl, {
        headers: { "User-Agent": SEC_UA },
      });
      if (!xmlRes.ok) continue;
      const xml = await xmlRes.text();
      results.push(...parseForm4Xml(xml, symbol, filingDate, accDash));
    } catch {
      continue;
    }

    // SEC rate limit: ~10 req/sec; small sleep between XML fetches
    await new Promise((r) => setTimeout(r, 120));
  }

  return results;
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    let symbolsParam = url.searchParams.get("symbols") ?? "";

    // If no symbols provided, pull from held positions + recent watchlist
    if (!symbolsParam) {
      const svc = createServiceClient();
      const [{ data: snapshot }, { data: watchlist }] = await Promise.all([
        svc
          .from("live_account_snapshots")
          .select("positions_json")
          .order("captured_at", { ascending: false })
          .limit(1)
          .single(),
        svc
          .from("agent_watchlist")
          .select("symbol")
          .eq("is_active", true)
          .limit(12),
      ]);

      const heldSymbols: string[] = [];
      if (snapshot?.positions_json) {
        const positions = Array.isArray(snapshot.positions_json)
          ? snapshot.positions_json
          : Object.values(snapshot.positions_json);
        for (const p of positions as any[]) {
          const s = (p.symbol ?? p.ticker ?? "").toUpperCase();
          if (s) heldSymbols.push(s);
        }
      }

      const watchSymbols = (watchlist ?? []).map((w: any) =>
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
    for (const symbol of symbols) {
      const cik = cikMap.get(symbol);
      if (!cik) continue;
      const txns = await fetchForm4sForSymbol(symbol, cik);
      allTx.push(...txns);
      // pace between symbols
      await new Promise((r) => setTimeout(r, 200));
    }

    allTx.sort((a, b) => b.date.localeCompare(a.date));

    return NextResponse.json({
      transactions: allTx,
      symbols,
      count: allTx.length,
      buys: allTx.filter((t) => t.transactionType === "buy").length,
      sells: allTx.filter((t) => t.transactionType === "sell").length,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
