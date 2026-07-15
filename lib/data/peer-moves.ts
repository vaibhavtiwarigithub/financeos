// Peer-move attention (features/stock-context).
//
// ATTENTION-ONLY. This is NOT a trade signal, NOT scored, and OFF THE MONEY
// PATH: nothing in scoring / sizing / gating / order code may import it. It only
// reads symbol_profiles.peers + a day-change map and renders "related names that
// moved" so the user notices them. It never recommends buying or selling.
//
// Deterministic: pure functions, no LLM, no I/O. Unit-tested in
// tests/peer-moves.test.ts.

// A peer move is "material" (worth surfacing) when the absolute day change is at
// least this many percent. Const, documented, deterministic — a peer that ticked
// 0.4% is noise; a 3%+ move is the kind of related-name event a human would want
// to glance at. This threshold is attention-only and is deliberately NOT a signal
// cutoff — nothing downstream trades on it.
export const MATERIAL_MOVE_PCT = 3;

export interface PeerMove {
  symbol: string;
  changePct: number; // day change in %, rounded to 1 decimal (display value)
  material: boolean; // |changePct| >= MATERIAL_MOVE_PCT
}

// Intraday day-change from one session's open/close, in percent. Matches the
// single grouped-daily snapshot the route fetches (and price_cache's open/close),
// so one Massive call is enough — no prior-close second call. Returns null when
// inputs are not usable (missing, non-finite, or non-positive open).
export function dayChangePct(open: number | null | undefined, close: number | null | undefined): number | null {
  if (open == null || close == null) return null;
  if (!Number.isFinite(open) || !Number.isFinite(close) || open <= 0) return null;
  return ((close - open) / open) * 100;
}

type ChangeMap = Map<string, number> | Record<string, number>;

function lookup(map: ChangeMap, sym: string): number | undefined {
  return map instanceof Map ? map.get(sym) : map[sym];
}

// Given a symbol's peers[] and a map of {ticker → dayChangePct}, return one
// PeerMove per peer that has a known change, de-duplicated and case-normalized.
// Deterministic ordering: material movers first, then by magnitude (largest
// move first), then alphabetically — so the same inputs always render the same
// list. Peers with no day-change data are dropped (nothing to say about them).
export function computePeerMoves(
  peers: readonly string[] | null | undefined,
  changeByTicker: ChangeMap,
  threshold: number = MATERIAL_MOVE_PCT,
): PeerMove[] {
  const seen = new Set<string>();
  const out: PeerMove[] = [];
  for (const raw of peers ?? []) {
    if (typeof raw !== "string") continue;
    const sym = raw.trim().toUpperCase();
    if (!sym || seen.has(sym)) continue;
    seen.add(sym);
    const change = lookup(changeByTicker, sym);
    if (change == null || !Number.isFinite(change)) continue;
    // Round to 1 decimal first so the material test matches the displayed value
    // (2.96 → 3.0 → material). Deterministic and consistent with the UI.
    const rounded = Math.round(change * 10) / 10;
    out.push({ symbol: sym, changePct: rounded, material: Math.abs(rounded) >= threshold });
  }
  out.sort((a, b) => {
    if (a.material !== b.material) return a.material ? -1 : 1;
    const mag = Math.abs(b.changePct) - Math.abs(a.changePct);
    if (mag !== 0) return mag;
    return a.symbol.localeCompare(b.symbol);
  });
  return out;
}

// Convenience: only the peers that moved materially (what the strip surfaces).
export function materialPeerMoves(
  peers: readonly string[] | null | undefined,
  changeByTicker: ChangeMap,
  threshold: number = MATERIAL_MOVE_PCT,
): PeerMove[] {
  return computePeerMoves(peers, changeByTicker, threshold).filter((p) => p.material);
}
