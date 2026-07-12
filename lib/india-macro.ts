// India macro backdrop — FII/DII institutional cash-market flows (the strongest
// free India macro signal). The US research path scores its macro dimension from
// FRED (US Treasuries / CPI / fed funds); India names have NO India-specific
// macro source, so this gives the India path a real, zero-cost institutional
// flow read to GROUND the thesis narrative (it does NOT recompute macro_score,
// which stays deterministic — mirrors how india-news grounds sentiment).
//
// Source: NSE's free `fiidiiTradeReact` JSON — the same daily provisional
// FII/FPI + DII cash-segment net buy/sell (₹ crore) every India desk watches.
// NSE sits behind an anti-bot cookie gate and geo-throttles some datacenter IPs,
// so this fails SOFT at every step: any block/parse failure returns null and the
// caller simply omits the India-macro line (never fabricates a flow number).
//
// Caching: a run-level in-memory TTL cache dedupes the per-symbol calls inside a
// single research pass (one real network hit per run), and providerCachedFetch
// adds the cross-process day cache + <=7d stale fallback under the free/no-budget
// "gdelt" bucket (NSE has no dedicated provider id; gdelt is the existing
// free/no-key India bucket).

import { providerCachedFetch } from "@/lib/data/provider-fetch";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

// One trading session's institutional cash-market net flow (₹ crore). Positive
// net = net buying that day. `null` on a field means NSE didn't carry it.
export interface FiiDiiSession {
  date: string | null; // NSE format, e.g. "10-Jul-2026"
  fiiNet: number | null;
  diiNet: number | null;
}

// Mint NSE session cookies (homepage first), then hand them to the API call.
// Fails soft → null (caller degrades to "no India-macro line").
async function nseCookie(): Promise<string | null> {
  try {
    const res = await fetch("https://www.nseindia.com/", {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9" },
      signal: AbortSignal.timeout(8000),
    });
    const raw = res.headers.get("set-cookie") ?? "";
    const cookie = raw.split(/,(?=[^;]+?=)/).map((c) => c.split(";")[0].trim()).filter(Boolean).join("; ");
    return cookie || null;
  } catch {
    return null;
  }
}

const num = (v: any): number | null => {
  const n = parseFloat(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

// Run-level cache: one real NSE hit per research pass, not one per India symbol.
let _mem: { at: number; data: FiiDiiSession[] | null } | null = null;
const MEM_TTL_MS = 30 * 60 * 1000;

// Recent daily FII/DII net cash-market flows, newest-first. NSE's live endpoint
// carries the latest completed session (FII/FPI + DII rows); returns that as a
// one-element array. Returns null when NSE is blocked/unreachable — the caller
// then leaves the India macro dimension as the US/global backdrop and adds no
// flow line. NEVER fabricates values.
export async function fetchFiiDiiFlows(): Promise<FiiDiiSession[] | null> {
  if (_mem && Date.now() - _mem.at < MEM_TTL_MS) return _mem.data;
  const data = await loadFiiDii();
  _mem = { at: Date.now(), data };
  return data;
}

async function loadFiiDii(): Promise<FiiDiiSession[] | null> {
  const cookie = await nseCookie();
  if (!cookie) return null;
  let json: any;
  try {
    json = await providerCachedFetch("gdelt", "NSE_FIIDII", "https://www.nseindia.com/api/fiidiiTradeReact", {
      timeoutMs: 8000,
      headers: { "User-Agent": UA, Accept: "application/json, text/plain, */*", "Accept-Language": "en-US,en;q=0.9", Referer: "https://www.nseindia.com/", Cookie: cookie },
      isThrottled: (j) => !Array.isArray(j) || j.length === 0,
    });
  } catch {
    return null;
  }
  const rows: any[] = Array.isArray(json) ? json : json?.data ?? [];
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const cat = (r: any) => String(r.category ?? r.clientType ?? "").toUpperCase();
  const fii = rows.find((r) => /FII|FPI/.test(cat(r)));
  const dii = rows.find((r) => /\bDII\b|DOMESTIC/.test(cat(r)));
  if (!fii && !dii) return null;

  const session: FiiDiiSession = {
    date: fii?.date ?? dii?.date ?? null,
    fiiNet: fii ? num(fii.netValue ?? (num(fii.buyValue) != null && num(fii.sellValue) != null ? (num(fii.buyValue)! - num(fii.sellValue)!) : null)) : null,
    diiNet: dii ? num(dii.netValue ?? (num(dii.buyValue) != null && num(dii.sellValue) != null ? (num(dii.buyValue)! - num(dii.sellValue)!) : null)) : null,
  };
  if (session.fiiNet == null && session.diiNet == null) return null;
  return [session];
}

// Build a short, factual India-macro line for the research prompt from live
// flows. Returns null when there's no usable data (so the caller appends
// nothing). Only reports real fetched net values — no interpretation beyond a
// plain risk-on/risk-off read of the sign.
export function fiiDiiMacroLine(sessions: FiiDiiSession[] | null): string | null {
  if (!sessions || sessions.length === 0) return null;
  const s = sessions[0];
  const parts: string[] = [];
  if (s.fiiNet != null) parts.push(`FII/FPI net ${s.fiiNet >= 0 ? "+" : ""}₹${s.fiiNet.toFixed(0)}cr`);
  if (s.diiNet != null) parts.push(`DII net ${s.diiNet >= 0 ? "+" : ""}₹${s.diiNet.toFixed(0)}cr`);
  if (parts.length === 0) return null;
  const asOf = s.date ? ` (as of ${s.date})` : "";
  let tone = "";
  if (s.fiiNet != null && s.diiNet != null) {
    if (s.fiiNet > 0 && s.diiNet > 0) tone = " — both buying, supportive domestic backdrop";
    else if (s.fiiNet < 0 && s.diiNet < 0) tone = " — both selling, risk-off backdrop";
    else if (s.fiiNet < 0 && s.diiNet > 0) tone = " — foreign outflow absorbed by domestics";
    else if (s.fiiNet > 0 && s.diiNet < 0) tone = " — foreign inflow, domestics booking";
  }
  return `India institutional flows (NSE cash segment${asOf}): ${parts.join(", ")}${tone}.`;
}
