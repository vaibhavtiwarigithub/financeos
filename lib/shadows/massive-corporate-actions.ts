import type { CorporateActionKind } from "@/lib/shadows/corporate-action-coverage";

/** Massive reference endpoint for one symbol/kind; the API key is appended by the caller's fetch layer. */
export function massiveActionPath(kind: CorporateActionKind, symbol: string, sinceYmd: string): string {
  const ticker = encodeURIComponent(symbol.trim().toUpperCase());
  return kind === "split"
    ? `/v3/reference/splits?ticker=${ticker}&execution_date.gte=${sinceYmd}&limit=100`
    : `/v3/reference/dividends?ticker=${ticker}&ex_dividend_date.gte=${sinceYmd}&limit=100`;
}

/**
 * Convert a Massive reference payload into the `{ data: [...] }` shape that
 * `assessCorporateActionPayload` validates. Returns null when the response
 * cannot certify completeness: a non-OK status, a missing results array, a
 * truncated (paginated) result set, or two splits on one ex-date. Two cash
 * dividends on one ex-date (e.g. PBR, 2026-08-25) are summed into one entitlement,
 * because the ledger key is (symbol, action_type, ex_date) and a holder receives
 * both; the replay still compares that total with the raw-bar provider's figure
 * and blocks on disagreement.
 */
export function normalizeMassiveActions(
  kind: CorporateActionKind,
  payload: unknown,
): { data: Record<string, unknown>[] } | null {
  const body = payload as { status?: unknown; results?: unknown; next_url?: unknown } | null;
  if (!body || body.status !== "OK" || !Array.isArray(body.results) || body.next_url) return null;

  const data: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const dividendIndex = new Map<string, number>();
  for (const value of body.results) {
    if (!value || typeof value !== "object") return null;
    const row = value as Record<string, unknown>;
    if (kind === "split") {
      const from = Number(row.split_from), to = Number(row.split_to);
      if (typeof row.execution_date !== "string" || !(from > 0) || !(to > 0)) return null;
      if (seen.has(row.execution_date)) return null;
      seen.add(row.execution_date);
      data.push({ effective_date: row.execution_date, split_factor: to / from });
    } else {
      if (typeof row.ex_dividend_date !== "string") return null;
      const existing = dividendIndex.get(row.ex_dividend_date);
      if (existing != null) {
        const first = Number(data[existing].amount), extra = Number(row.cash_amount);
        // A non-numeric amount is left for the shared assessor to reject.
        data[existing].amount = Number.isFinite(first) && Number.isFinite(extra) ? first + extra : Number.NaN;
        continue;
      }
      dividendIndex.set(row.ex_dividend_date, data.length);
      data.push({ ex_dividend_date: row.ex_dividend_date, amount: row.cash_amount });
    }
  }
  return { data };
}
