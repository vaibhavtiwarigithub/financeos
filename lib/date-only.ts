const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Validate a calendar date without allowing JavaScript's overflow normalization. */
export function isRealIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Normalize a provider value to YYYY-MM-DD only when that day really exists. */
export function normalizeRealIsoDate(value: unknown): string | null {
  const candidate = typeof value === "string" ? value.trim().slice(0, 10) : "";
  return isRealIsoDate(candidate) ? candidate : null;
}
