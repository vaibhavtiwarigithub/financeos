const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Validate a calendar date without allowing JavaScript's overflow normalization. */
export function isRealIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * The ONE earnings/report date parser. Every collector routes through this so a
 * malformed provider value is rejected identically everywhere; a second copy
 * would drift, which is exactly how the four earnings collectors ended up with
 * three different validation rules.
 *
 * Accepts a YYYY-MM-DD string (with or without a time suffix) or a provider
 * epoch timestamp in seconds or milliseconds. Returns null — never a coerced,
 * valid-looking date — for anything else, including impossible calendar days
 * such as 2026-02-30 that JavaScript would silently roll forward.
 */
export function normalizeRealIsoDate(value: unknown): string | null {
  if (typeof value === "number" || (typeof value === "bigint")) {
    return fromEpoch(Number(value));
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  // 10 or 13 digits only. A bare "20260730" is a compact calendar date, not an
  // epoch, and must stay a rejection rather than become 1970-08-23.
  if (/^\d{10}$|^\d{13}$/.test(trimmed)) return fromEpoch(Number(trimmed));
  const candidate = trimmed.slice(0, 10);
  return isRealIsoDate(candidate) ? candidate : null;
}

// Same seconds-vs-milliseconds heuristic as daysFromToday in lib/data/earnings.ts.
// UTC day, matching what the India Yahoo collector produced before it was shared.
function fromEpoch(epoch: number): string | null {
  if (!Number.isFinite(epoch) || epoch <= 0) return null;
  const date = new Date(epoch < 100_000_000_000 ? epoch * 1000 : epoch);
  if (!Number.isFinite(date.getTime())) return null;
  const iso = date.toISOString().slice(0, 10);
  return isRealIsoDate(iso) ? iso : null;
}
