import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { getSymbolProfile, type ProfileMarket } from "@/lib/data/symbol-profile";
import { computePeerMoves, dayChangePct, type PeerMove } from "@/lib/data/peer-moves";
import { isIndia } from "@/lib/india-data";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/peer-moves?symbol=NVDA&market=us|india
//
// ATTENTION-ONLY, OFF THE MONEY PATH. Given a symbol, returns its peers' latest
// day moves so the user notices a related name that moved (e.g. on NVDA: "AMD
// -4.1%, AVGO +3.2%"). This is NOT a trade signal — it is never scored, never
// sized, never imported by order/gating code. Display only.
//
// FREE-TIER PACING (free-cloud-only hard rule): peer day-change comes from ONE
// Massive grouped-daily call — `/v2/aggs/grouped/locale/us/market/stocks/{date}`
// returns EVERY US ticker's prior-session OHLC in a single request, so arbitrary
// peers are covered without firing one call per peer. Peers already warm in
// price_cache are read from there first; the grouped call only runs if some peer
// is missing. Day change = (close-open)/open*100 (same session, one snapshot) —
// consistent with price-cache-fill's stored open/close.
//
// India: no free peers source → symbol_profiles.peers is [] → this returns an
// empty list and the UI shows nothing. Handled gracefully, never a Massive call.
// ─────────────────────────────────────────────────────────────────────────────

interface GroupedAgg { T?: string; o?: number; c?: number }

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Most recent completed weekday session (holidays just yield an empty grouped
// snapshot and we walk back a day).
function mostRecentWeekday(from = new Date()): Date {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() - 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

// One grouped-daily snapshot for `date`, reduced to {ticker → (close-open)/open%}
// for the requested peer set. Returns null on a non-trading day / 429 / error so
// the caller can walk back or fail-soft.
async function fetchGroupedChanges(
  date: string,
  wanted: Set<string>,
  apiKey: string,
): Promise<Map<string, number> | null> {
  try {
    const res = await fetch(
      `https://api.massive.com/v2/aggs/grouped/locale/us/market/stocks/${date}?adjusted=true&apiKey=${apiKey}`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(25_000), cache: "no-store" },
    );
    if (!res.ok) return null;
    const data: { results?: GroupedAgg[] } = await res.json();
    const results = data.results ?? [];
    if (results.length === 0) return null; // non-trading day → walk back
    const out = new Map<string, number>();
    for (const r of results) {
      if (!r.T || !wanted.has(r.T)) continue;
      const chg = dayChangePct(r.o, r.c);
      if (chg != null) out.set(r.T, chg);
    }
    return out;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const sp = req.nextUrl.searchParams;
  const symbolRaw = sp.get("symbol");
  if (!symbolRaw) return NextResponse.json({ error: "symbol required" }, { status: 400 });
  const symbol = symbolRaw.trim().toUpperCase();

  const mktParam = sp.get("market");
  const market: ProfileMarket = mktParam === "india" ? "india"
    : mktParam === "us" ? "us"
    : (isIndia(symbol) ? "india" : "us");

  const svc = createServiceClient();

  // 1) Peers from the Stock Context cache (read-through). Fail-soft.
  let peers: string[] = [];
  try {
    const profile = await getSymbolProfile(symbol, market, svc);
    peers = (profile?.peers ?? []).map((p) => p.toUpperCase());
  } catch {
    peers = [];
  }

  // India (or any symbol with no peers): nothing to source, no Massive call.
  if (market === "india" || peers.length === 0) {
    return NextResponse.json({ symbol, market, asOf: null, source: "none", moves: [] as PeerMove[] });
  }

  const wanted = new Set(peers);
  const changeByTicker = new Map<string, number>();
  let asOf: string | null = null;
  let source: "price_cache" | "grouped" | "mixed" | "none" = "none";

  // 2) Reuse price_cache first — if peers are already warm, no provider call.
  //    Use the single most-recent cached session common to these peers.
  try {
    const { data: rows } = await svc
      .from("price_cache")
      .select("symbol, date, open, close")
      .in("symbol", peers)
      .order("date", { ascending: false })
      .limit(peers.length * 3);
    if (rows && rows.length > 0) {
      const latestDate = (rows as { date: string }[])[0].date;
      asOf = latestDate;
      for (const r of rows as { symbol: string; date: string; open: number; close: number }[]) {
        if (r.date !== latestDate) continue;
        const chg = dayChangePct(r.open, r.close);
        if (chg != null && !changeByTicker.has(r.symbol)) changeByTicker.set(r.symbol, chg);
      }
      if (changeByTicker.size > 0) source = "price_cache";
    }
  } catch { /* fail-soft — fall through to grouped */ }

  // 3) Only if some peer is still missing, do ONE grouped-daily call (never one
  //    call per peer). Walk back a few weekdays if the latest day is a holiday.
  const missing = peers.filter((p) => !changeByTicker.has(p));
  const apiKey = process.env.MASSIVE_API_KEY;
  if (missing.length > 0 && apiKey) {
    const missingSet = new Set(missing);
    const d = mostRecentWeekday();
    for (let step = 0; step < 4; step++) {
      if (d.getUTCDay() === 0 || d.getUTCDay() === 6) { d.setUTCDate(d.getUTCDate() - 1); continue; }
      const date = ymd(d);
      const changes = await fetchGroupedChanges(date, missingSet, apiKey);
      if (changes && changes.size > 0) {
        for (const [sym, chg] of changes) if (!changeByTicker.has(sym)) changeByTicker.set(sym, chg);
        asOf = asOf ?? date;
        source = source === "price_cache" ? "mixed" : "grouped";
        break;
      }
      d.setUTCDate(d.getUTCDate() - 1); // holiday/empty → walk back one weekday
    }
  }

  // 4) Deterministic peer-move list (material first). Attention-only.
  const moves = computePeerMoves(peers, changeByTicker);

  return NextResponse.json({ symbol, market, asOf, source, moves });
}
