#!/usr/bin/env node
// P0 feasibility probe for features/relationship-graph — READ-ONLY, measure-only.
//
// Question: for Kairos's real US universe, can we obtain a point-in-time
// disclosed-customer link (named customer + revenue share + available_at)
// from free SEC EDGAR data?
//
// This script does NOT build a graph, score anything, write to the DB, or
// touch the money path. It fetches each issuer's latest 10-K, extracts
// candidate customer-concentration spans, and writes them to a JSON file for
// HUMAN adjudication. The regex is a RECALL net, not a classifier — the
// coverage numbers in P0_COVERAGE_STUDY.md come from reading the spans, not
// from this script's guesses.
//
// SEC fair access: declared User-Agent, ~1 req/s (SEC ceiling is 10/s), and a
// bounded sample. SEC_UA is required — set it to your own contact string before running.
//
// Usage:
//   node scripts/sec-customer-coverage-probe.mjs [--limit N] [--out FILE]
//
// Sample frame provenance: US operating companies in Kairos's live universe
// (watchlist where not expired + US paper_positions with qty>0), pulled
// 2026-07-16 from the FinanceOS Supabase project, minus KNOWN_US_ETFS
// (lib/asset-classification.ts). This mirrors gatherSymbols()'s US equity
// surface in lib/research-agent.ts.

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

// SEC fair access requires a declared contact. Supply your own via SEC_UA; no
// contact address is hardcoded here so this file stays free of personal data.
const SEC_UA = process.env.SEC_UA;
if (!SEC_UA) {
  console.error('SEC_UA is required. SEC fair-access guidance requires a declared contact User-Agent.\n' +
                'Example: SEC_UA="Kairos P0 probe (you@example.com)" node scripts/sec-customer-coverage-probe.mjs');
  process.exit(1);
}
const RATE_MS = 1100; // ~0.9 req/s — deliberately an order of magnitude under SEC's 10/s ceiling

// --- Sample frame (see provenance note above) --------------------------------
const ETFS = new Set([
  "SPY","VOO","QQQ","IWM","VTI","DIA","RSP","IVV","SCHD","VTV","VONG","SPHQ","SPMO","SGOV","DBA",
  "XLK","XLF","XLE","XLI","XLV","XLU","XLRE","XLB","XLC","XLP","XLY","SMH","SOXX","IBB","KRE","KBE","ITB","XME",
  "BOTZ","AIQ","ICLN","NLR","ARKK","ARKG","ARKW","ARKF","ARKX","CIBR","ROBO","SKYY","WCLD","BUG","REMX","TEM",
  "TQQQ","SOXL","SPXL","UPRO","TECL","FAS","DUSL","DRN","UGL","FNGU","LABU","HIBL","MSTU","NVDL",
  "SQQQ","SOXS","SPXS","SPDN","FAZ","SIJ","DRV","GLL","SDOW","FNGD","LABD","HIBS","MSTZ","NVDD",
  "USO","GLD","SLV","UNG","PDBC","IAU","GDX","GDXJ",
  "TLT","SHY","IEF","HYG","LQD","BND","AGG","GOVT","IBIT","BITO","GBTC",
  "INDA","EPI","INDY","EUAD","FEZ","VGK","EWG","EWL","EWU","EWQ","DXJ","EWJ","EWT","EWY","EWH","FXI","ASHR","EMXC",
  "VT","ACWI","EFA",
  // present in the live universe, ETF/thematic-fund tickers not in the shared list
  "ARKQ","BUZZ","HOMZ","IZRL","MAGS","QTUM","SPCX","VHT","XBI","XHB","XT","NLR",
]);

const RAW_UNIVERSE = [
  // paper_positions (US, qty>0)
  "AXP","BAC","DXJ","EXEL","HOOD","LNG","OXY","PLTR","RDDT","SIRI","SPHQ",
  // watchlist (not expired)
  "AAPL","AGNT","AKAM","AMAT","AMD","AMT","AMZN","APP","ARKF","ARKG","ARKK","ARKQ","ARKW","ARM","ASML",
  "AVGO","BBAI","BE","BLNK","BOTZ","BUZZ","BX","CELH","CHD","CHPT","COIN","CRM","CRNT","CRWD","CRWV",
  "CYBR","DBA","DIA","DLR","DTE","DUK","EBAY","ENN","ENPH","EQIX","EQNR","F","FFIV","FSLR","FSLY","GLD",
  "GOOGL","GS","HD","HOMZ","ICE","INTC","INVH","IONQ","ISRG","ITB","IWM","IZRL","LOW","MAGS","MELI","META",
  "MRVL","MSFT","MTH","MU","NEE","NLR","NTTYY","NVDA","ODFL","OKE","OKLO","ORCL","PANW","PCG","PGR","PYPL",
  "QCOM","QQQ","QTUM","QUBT","RGTI","RUN","SHOP","SKHYV","SMCI","SMH","SMR","SOUN","SOXL","SPCX","SPY","SQ",
  "STM","SWK","TJX","TMHC","TRV","TSLA","TSM","USO","VHT","VMW","VWDRY","VZ","WFC","XBI","XHB","XLC","XLE",
  "XLF","XLI","XLK","XLP","XLU","XLV","XLY","XT",
];

const SAMPLE = [...new Set(RAW_UNIVERSE.map(s => s.toUpperCase()))].filter(s => !ETFS.has(s)).sort();

// --- Extraction --------------------------------------------------------------

// Recall net: a paragraph is a candidate if it mentions a customer AND a percent,
// OR uses standard concentration phrasing. Intentionally over-inclusive; a human
// adjudicates. Under-inclusion would silently inflate the "no disclosure" bucket.
const CUSTOMER_RE = /\b(customer|client|distributor|reseller|end.customer|purchaser)s?\b/i;
const PCT_RE = /\b\d{1,3}(\.\d+)?\s?%|\bten percent\b|\b10 percent\b/i;
const CONCENTRATION_RE = /(accounted for|represented|comprised|constituted|derived|attributable to|concentration of credit risk|majority of (our|its) (net )?(revenue|sales))/i;
const LEGAL_NAME_RE = /\b[A-Z][A-Za-z&.'-]*(?:\s+[A-Z][A-Za-z&.'-]*){0,5}\s+(?:Inc\.?|Corp\.?|Corporation|LLC|Ltd\.?|Limited|plc)\b/;
const MEGACAP_RE = /\b(?:Walmart|Home Depot|Lowe'?s|Costco|Pepsi(?:Co)?|Microsoft|Apple|Samsung|Xiaomi|Amazon|Google|Alphabet|Meta|T-Mobile|AT&T|Verizon|Telef[oó]nica)\b/i;

function stripHtml(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"')
    .replace(/&[a-z]+;|&#\d+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findSpans(text) {
  // Sentence-ish windows so a human can read each hit in context.
  const sentences = text.split(/(?<=\.)\s+(?=[A-Z(])/);
  const hits = [];
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    if (s.length > 2000) continue; // table sludge
    const nets = [];
    if (CUSTOMER_RE.test(s)) nets.push("customer_concentration");
    if (LEGAL_NAME_RE.test(s)) nets.push("legal_suffix");
    if (MEGACAP_RE.test(s)) nets.push("mega_cap_gazetteer");
    if (nets.length === 0) continue;
    if (!PCT_RE.test(s) && !CONCENTRATION_RE.test(s)) continue;
    // include one neighbour each side: the customer name is often in the next sentence
    const span = [sentences[i - 1], s, sentences[i + 1]].filter(Boolean).join(" ").slice(0, 1200);
    hits.push({ span, nets });
    if (hits.length >= 12) break; // bound output per issuer
  }
  const unique = new Map();
  for (const hit of hits) {
    const prior = unique.get(hit.span);
    unique.set(hit.span, prior
      ? { span: hit.span, nets: [...new Set([...prior.nets, ...hit.nets])].sort() }
      : hit);
  }
  return [...unique.values()];
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, asJson) {
  const r = await fetch(url, { headers: { "User-Agent": SEC_UA, "Accept-Encoding": "gzip, deflate" } });
  await sleep(RATE_MS);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return asJson ? r.json() : r.text();
}

async function main() {
  const args = process.argv.slice(2);
  const limitArg = args.indexOf("--limit");
  const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : SAMPLE.length;
  const outArg = args.indexOf("--out");
  const out = outArg >= 0 ? args[outArg + 1] : "sec-probe-results.json";

  console.error(`[probe] sample frame: ${SAMPLE.length} US non-ETF symbols; probing ${Math.min(limit, SAMPLE.length)}`);

  const tickers = await get("https://www.sec.gov/files/company_tickers.json", true);
  const byTicker = new Map();
  for (const v of Object.values(tickers)) byTicker.set(v.ticker.toUpperCase(), { cik: String(v.cik_str).padStart(10, "0"), name: v.title });

  const results = [];
  for (const symbol of SAMPLE.slice(0, limit)) {
    const rec = { symbol, status: null, cik: null, company: null, form: null, accession: null,
                  filingDate: null, acceptanceDateTime: null, reportDate: null, docUrl: null,
                  documentSha256: null, candidates: [] };
    try {
      const hit = byTicker.get(symbol);
      if (!hit) { rec.status = "no_cik_in_sec_ticker_map"; results.push(rec); console.error(`  ${symbol}: ${rec.status}`); continue; }
      rec.cik = hit.cik; rec.company = hit.name;

      const sub = await get(`https://data.sec.gov/submissions/CIK${hit.cik}.json`, true);
      const f = sub.filings.recent;
      let idx = f.form.findIndex(x => x === "10-K");
      if (idx < 0) {
        const fidx = f.form.findIndex(x => x === "20-F" || x === "40-F");
        rec.status = fidx >= 0 ? "foreign_private_issuer_no_10k" : "no_10k_found";
        rec.form = fidx >= 0 ? f.form[fidx] : null;
        results.push(rec); console.error(`  ${symbol}: ${rec.status}`); continue;
      }
      rec.form = f.form[idx];
      rec.accession = f.accessionNumber[idx];
      rec.filingDate = f.filingDate[idx];
      rec.acceptanceDateTime = f.acceptanceDateTime[idx]; // <- the point-in-time available_at
      rec.reportDate = f.reportDate[idx];

      const accNo = rec.accession.replace(/-/g, "");
      rec.docUrl = `https://www.sec.gov/Archives/edgar/data/${Number(hit.cik)}/${accNo}/${f.primaryDocument[idx]}`;
      const html = await get(rec.docUrl, false);
      rec.documentSha256 = createHash("sha256").update(html).digest("hex");
      rec.candidates = findSpans(stripHtml(html));
      rec.status = rec.candidates.length ? "spans_found" : "no_candidate_span";
      console.error(`  ${symbol}: ${rec.status} (${rec.candidates.length} spans, 10-K ${rec.filingDate})`);
    } catch (e) {
      rec.status = `error: ${e.message}`;
      console.error(`  ${symbol}: ${rec.status}`);
    }
    results.push(rec);
  }

  writeFileSync(out, JSON.stringify({
    probedAt: new Date().toISOString(),
    sampleFrameSize: SAMPLE.length,
    sampleFrame: SAMPLE,
    sampleFrameSha256: createHash("sha256").update(SAMPLE.join("\n")).digest("hex"),
    probed: results.length,
    recallNets: ["customer_concentration", "legal_suffix", "mega_cap_gazetteer"],
    note: "candidates are recall-net output for human adjudication, not classifier verdicts",
    results,
  }, null, 2));
  console.error(`[probe] wrote ${out}`);
}

main();
