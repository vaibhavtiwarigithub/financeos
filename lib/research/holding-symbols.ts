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
