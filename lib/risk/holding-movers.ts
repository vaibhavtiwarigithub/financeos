// Top gainers and losers among a user's OWN holdings — CACHE ONLY.
//
// Seeking Alpha's digest has a "Yesterday's Performance" block. This is the
// version that fits the cost rule in
// features/per-user-broker-risk/FEATURE_ARCHITECTURE.md §6: a guest path may
// read cache, but may never call a metered provider outside it.
//
// So this reads `price_cache` and nothing else. A symbol with no cached pair of
// consecutive sessions is reported as UNCOVERED, never fetched — which means
// the block can be partial, and says so, rather than quietly omitting holdings
// and presenting a leaderboard that looks complete but isn't. A "top loser"
// list that silently dropped the worst loser because it wasn't cached would be
// worse than showing nothing.
//
// The move is computed close-over-previous-close (a true daily change), the
// same basis `/api/markets/quotes` uses — never intraday (close - open), which
// is a different number that happens to look similar.

import type { SupabaseClient } from "@supabase/supabase-js";

export type Mover = {
  symbol: string;
  changePct: number;
  close: number;
  prevClose: number;
  date: string;
};

export type MoversResult = {
  gainers: Mover[];
  losers: Mover[];
  /** Held symbols with no usable cached pair. Named, not hidden. */
  uncovered: string[];
  /** The session the moves are measured on, or null when nothing was usable. */
  asOfDate: string | null;
};

/**
 * `limit` caps each side of the list. Symbols come from the caller's own
 * holdings; nothing here widens the symbol set or triggers a fetch.
 */
export async function holdingMovers(
  svc: Pick<SupabaseClient, "from">,
  symbols: string[],
  limit = 3,
): Promise<MoversResult> {
  const unique = Array.from(new Set(symbols.map((s) => s.toUpperCase()))).filter(Boolean);
  if (!unique.length) return { gainers: [], losers: [], uncovered: [], asOfDate: null };

  // Two most recent cached rows per symbol. Ordering by date descending and
  // taking the first two per symbol gives the latest close and the one before
  // it, whatever gaps exist — a symbol that missed a session still compares two
  // real consecutive CACHED sessions rather than inventing a flat day.
  const { data } = await svc
    .from("price_cache")
    .select("symbol, date, close")
    .in("symbol", unique)
    .order("date", { ascending: false })
    .limit(unique.length * 6);

  const bySymbol = new Map<string, Array<{ date: string; close: number }>>();
  for (const row of (data ?? []) as Array<{ symbol: string; date: string; close: number }>) {
    const sym = String(row.symbol).toUpperCase();
    const close = Number(row.close);
    if (!Number.isFinite(close) || close <= 0) continue;
    const list = bySymbol.get(sym) ?? [];
    if (list.length < 2) {
      list.push({ date: String(row.date), close });
      bySymbol.set(sym, list);
    }
  }

  const movers: Mover[] = [];
  const uncovered: string[] = [];
  for (const sym of unique) {
    const pair = bySymbol.get(sym);
    if (!pair || pair.length < 2) { uncovered.push(sym); continue; }
    const [latest, prev] = pair;
    movers.push({
      symbol: sym,
      changePct: (latest.close - prev.close) / prev.close,
      close: latest.close,
      prevClose: prev.close,
      date: latest.date,
    });
  }

  const sorted = [...movers].sort((a, b) => b.changePct - a.changePct);
  // A symbol appears on at most one side: with fewer holdings than 2×limit the
  // same name would otherwise be both a top gainer and a top loser.
  const gainers = sorted.filter((m) => m.changePct > 0).slice(0, limit);
  const losers = sorted.filter((m) => m.changePct < 0).reverse().slice(0, limit);

  // The session the list is measured on is the newest date any mover used.
  const asOfDate = movers.length
    ? movers.map((m) => m.date).sort().slice(-1)[0]
    : null;

  return { gainers, losers, uncovered: uncovered.sort(), asOfDate };
}
