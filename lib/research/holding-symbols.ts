type LiveSnapshotRow = {
  account_id?: string | null;
  broker?: string | null;
  captured_at?: string | null;
  positions_json?: unknown;
};

function normalizeSymbol(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const symbol = value.trim().toUpperCase();
  return symbol || null;
}

export function symbolsFromLatestLiveSnapshots(rows: LiveSnapshotRow[]): string[] {
  const latestByAccount = new Map<string, LiveSnapshotRow>();
  for (const row of rows) {
    const key = `${row.broker ?? "unknown"}:${row.account_id ?? "default"}`;
    const prior = latestByAccount.get(key);
    if (!prior || String(row.captured_at ?? "") > String(prior.captured_at ?? "")) latestByAccount.set(key, row);
  }

  const symbols = new Set<string>();
  for (const row of latestByAccount.values()) {
    if (!Array.isArray(row.positions_json)) continue;
    for (const position of row.positions_json as Array<Record<string, unknown>>) {
      const symbol = normalizeSymbol(position.symbol);
      const qtyRaw = position.qty ?? position.quantity;
      const qty = qtyRaw == null ? 1 : Number(qtyRaw);
      if (symbol && Number.isFinite(qty) && qty > 0) symbols.add(symbol);
    }
  }
  return [...symbols].sort();
}

export function symbolsFromPaperPositions(rows: Array<{ symbol?: unknown; qty?: unknown }>, market: "us" | "india"): string[] {
  const symbols = new Set<string>();
  for (const row of rows) {
    const raw = normalizeSymbol(row.symbol);
    const qty = Number(row.qty);
    if (!raw || !Number.isFinite(qty) || qty <= 0) continue;
    const symbol = market === "india" && !raw.endsWith(".NS") && !raw.endsWith(".BO") ? `${raw}.NS` : raw;
    symbols.add(symbol);
  }
  return [...symbols].sort();
}

export function unionHoldingSymbols(...groups: string[][]): string[] {
  return [...new Set(groups.flat().map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))].sort();
}

/**
 * Order holdings least-recently-scored FIRST.
 *
 * WHY THIS EXISTS (bug, 2026-07-16): holdings are exempt from the candidate cap
 * but NOT from the cron's wall-clock budget (RESEARCH_BUDGET_MS). Throughput is
 * ~30 symbols/run; the US book holds 56. Because the holdings order was STABLE
 * (account capture order, then alphabetical after the holding-symbols refactor),
 * the SAME tail was cut every single run — forever. Proven in prod: run
 * a4530e8f (2026-07-16) scored batch slots 1-30 (30/30 signals) and slots 31-56
 * — all holdings — got 0. AVGO (slot 55) went unscored from 07-13 onward while
 * Risk Analytics was telling the owner to trim it.
 *
 * Sorting by staleness makes the cut ROTATE instead of starve: whatever the
 * budget misses this run is the oldest, so it sorts to the front next run. A
 * holding can now be late, but it can no longer be permanently invisible.
 *
 * NOTE: this bounds worst-case staleness at ceil(nHoldings / throughput) runs;
 * it does NOT make every holding score every session — that is a capacity
 * question (see WORK_LOG / docs/arch/03-agents.md), not an ordering one.
 *
 * Deterministic: never-scored first, then oldest first, alphabetical tiebreak.
 */
export function orderHoldingsByStaleness(
  symbols: string[],
  lastScoredAt: Map<string, string | null | undefined>,
): string[] {
  return [...symbols].sort((a, b) => {
    const aAt = lastScoredAt.get(a) ?? "";
    const bAt = lastScoredAt.get(b) ?? "";
    // "" (never scored) sorts first because it compares less than any ISO date.
    if (aAt !== bAt) return aAt < bAt ? -1 : 1;
    return a.localeCompare(b);
  });
}
