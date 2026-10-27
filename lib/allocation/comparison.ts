import { ALLOCATION_BUCKETS, allocationBucket, validateAllocation, type AllocationPolicy, type AllocationPosition } from "./profiles";

export type AllocationBook = {
  nav: number; cash: number | null; positions: AllocationPosition[];
  asOf?: string | null; note?: string; error?: string;
};

const number = (value: unknown): number => value == null || value === "" ? NaN : Number(value);

/** Read-only display arithmetic. Never feeds entry sizing or normalizes missing data. */
export function compareAllocation(policy: AllocationPolicy, book: AllocationBook | null) {
  const rows = ALLOCATION_BUCKETS.map(bucket => ({ bucket, targetPct: policy.targets[bucket], currentPct: null as number | null }));
  const fail = (error: string) => ({ rows, extra: [] as { label: string; pct: number }[], error });
  if (validateAllocation(policy, policy.market)) return fail("Saved allocation goals could not be verified.");
  if (!book || book.error) return fail(book?.error ?? "Portfolio values are unavailable.");
  if (!Number.isFinite(book.nav) || book.nav <= 0) return fail("No verified positive portfolio value to allocate.");
  if (book.cash != null && (!Number.isFinite(book.cash) || book.cash < 0)) return fail("Cash is invalid or negative; a long-only allocation cannot be shown.");
  const used = Object.fromEntries(ALLOCATION_BUCKETS.map(key => [key, 0])) as Record<string, number>;
  let unknown = 0, holdings = 0;
  for (const p of book.positions) {
    if (!Number.isFinite(p.marketValue) || p.marketValue < 0) return fail("One or more holdings have missing marks or unsupported short exposure.");
    holdings += p.marketValue;
    const bucket = allocationBucket(p.symbol, policy.market, p.assetClass);
    if (bucket) used[bucket] += p.marketValue; else unknown += p.marketValue;
  }
  const tolerance = Math.max(0.01, book.nav * 0.000001);
  const remainder = book.nav - holdings - (book.cash ?? 0);
  if (remainder < -tolerance || (book.cash != null && Math.abs(remainder) > tolerance)) return fail("Holdings and cash do not reconcile to portfolio value. Current mix is withheld.");
  used.tactical += book.cash ?? 0;
  for (const row of rows) row.currentPct = used[row.bucket] / book.nav * 100;
  const extra = [];
  if (unknown > 0) extra.push({ label: "Other / unclassified holdings", pct: unknown / book.nav * 100 });
  if (book.cash == null && remainder > 0) extra.push({ label: "Unverified account balance", pct: remainder / book.nav * 100 });
  return { rows, extra, error: null };
}

/** Same-snapshot valuation; no quote fetch, cost-basis fallback or buying-power cash. */
export function liveSnapshotAllocation(snapshots: any[]): AllocationBook {
  const latest = new Map<string, any>();
  let excluded = 0;
  for (const snap of snapshots) {
    if (!["robinhood", "webull", "alpaca_live"].includes(snap.broker)
      || /paper|simulat|crypto/i.test(String(snap.account_type ?? ""))) { excluded++; continue; }
    if (!snap.account_id) return { nav: NaN, cash: null, positions: [], error: "A selected account has no verified identity." };
    const key = `${snap.broker}:${snap.account_id}`;
    if (!latest.has(key) || Date.parse(snap.captured_at) > Date.parse(latest.get(key).captured_at)) latest.set(key, snap);
  }
  const positions: AllocationPosition[] = [];
  let nav = 0, oldest = Infinity;
  const fail = (error: string): AllocationBook => ({ nav: NaN, cash: null, positions: [], error });
  if (!latest.size) return fail("Select a real US equity account with a saved snapshot.");
  for (const snap of latest.values()) {
    const equity = number(snap.equity ?? snap.portfolio_value), at = Date.parse(snap.captured_at);
    if (!Number.isFinite(equity) || equity < 0 || !Number.isFinite(at) || at > Date.now() || !Array.isArray(snap.positions_json)) return fail("A selected account snapshot is incomplete or has invalid values/timestamps.");
    if (snap.position_count != null && number(snap.position_count) !== snap.positions_json.length) return fail("A selected account's position count does not match its saved holdings.");
    nav += equity; oldest = Math.min(oldest, at);
    for (const p of snap.positions_json) {
      const qty = number(p.quantity ?? p.qty);
      if (qty === 0) continue;
      if (!Number.isFinite(qty) || qty < 0 || p.side === "short" || typeof p.symbol !== "string" || !p.symbol.trim()) return fail("A holding has missing identity/quantity or unsupported short exposure.");
      const price = number(p.current_price ?? p.currentPrice ?? p.market_price ?? p.last_trade_price);
      const value = p.market_value == null ? qty * price : number(p.market_value);
      if (!Number.isFinite(value) || value <= 0) return fail("A selected holding lacks a positive broker market value. Cost basis is not a current price.");
      positions.push({ symbol: p.symbol, marketValue: value, assetClass: p.asset_class ?? p.assetClass });
    }
  }
  return { nav, cash: null, positions, asOf: new Date(oldest).toISOString(), note: `Selected real US accounts · saved broker marks. Residual value is unverified, not buying power or confirmed cash.${excluded ? ` ${excluded} out-of-scope snapshot(s) excluded.` : ""}` };
}
