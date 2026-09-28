export type CorporateActionKind = "split" | "dividend";
export type CoverageStatus = "complete" | "invalid" | "stale" | "error";

export interface CoverageAssessment {
  status: CoverageStatus;
  recordsCount: number;
  reason: string | null;
}

export function selectCorporateActionCoverageBatch(
  candidates: string[],
  priorRows: Array<{ symbol: string; action_type: string; checked_at: string }>,
  limit = 5,
): string[] {
  const latest = new Map<string, number>();
  for (const row of priorRows) {
    const key = `${row.symbol}:${row.action_type}`;
    const checkedAt = Date.parse(row.checked_at) || 0;
    latest.set(key, Math.max(latest.get(key) ?? 0, checkedAt));
  }
  return [...new Set(candidates)].map((symbol) => ({
    symbol,
    checkedAt: Math.min(latest.get(`${symbol}:split`) ?? 0, latest.get(`${symbol}:dividend`) ?? 0),
  })).sort((a, b) => a.checkedAt - b.checkedAt || a.symbol.localeCompare(b.symbol))
    .slice(0, Math.max(0, limit)).map((row) => row.symbol);
}

/**
 * Validate the provider contract before treating an empty event list as proof
 * that no split/dividend occurred. Completeness is always bounded by the real
 * provider fetch timestamp, never by the cache-slot date.
 */
export function assessCorporateActionPayload(input: {
  kind: CorporateActionKind;
  payload: unknown;
  providerFetchedAt: string | null;
  now?: Date;
  maxAgeDays?: number;
}): CoverageAssessment {
  const { kind, payload } = input;
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) {
    return { status: "invalid", recordsCount: 0, reason: "Provider payload did not contain a data array." };
  }

  for (const [index, value] of data.entries()) {
    if (!value || typeof value !== "object") {
      return { status: "invalid", recordsCount: data.length, reason: `Record ${index} is not an object.` };
    }
    const row = value as Record<string, unknown>;
    const date = kind === "split"
      ? row.effective_date ?? row.ex_date
      : row.ex_dividend_date ?? row.ex_date;
    const parsedDate = typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? new Date(`${date}T00:00:00Z`)
      : null;
    if (typeof date !== "string" || !parsedDate || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
      return { status: "invalid", recordsCount: data.length, reason: `Record ${index} has no valid effective date.` };
    }
    const rawValue = kind === "split" ? row.split_factor ?? row.ratio : row.amount;
    const numeric = typeof rawValue === "number" ? rawValue : Number(rawValue);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return { status: "invalid", recordsCount: data.length, reason: `Record ${index} has no positive ${kind === "split" ? "split factor" : "dividend amount"}.` };
    }
  }

  if (!input.providerFetchedAt) {
    return { status: "stale", recordsCount: data.length, reason: "No original provider fetch timestamp is available." };
  }
  const fetched = Date.parse(input.providerFetchedAt);
  const now = (input.now ?? new Date()).getTime();
  const maxAgeMs = (input.maxAgeDays ?? 30) * 86_400_000;
  if (!Number.isFinite(fetched) || fetched > now + 60_000 || now - fetched > maxAgeMs) {
    return { status: "stale", recordsCount: data.length, reason: "Original provider response is outside the freshness bound." };
  }
  return { status: "complete", recordsCount: data.length, reason: null };
}
