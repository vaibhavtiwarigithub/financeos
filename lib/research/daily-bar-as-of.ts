/** Returns a safe YYYY-MM-DD label for an immutable daily-bar observation. */
export function dailyBarAsOfLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})(?:$|T)/);
  if (!match) return null;
  const date = new Date(`${match[1]}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === match[1]
    ? match[1]
    : null;
}
