export function resolvePaperExitThreshold(entryThreshold: number, hysteresis: number): number {
  const entry = Number.isFinite(entryThreshold) ? entryThreshold : 60;
  const gap = Number.isFinite(hysteresis) && hysteresis > 0 ? hysteresis : 15;
  return Math.max(35, entry - gap);
}

export function paperPositionOpenedAt(position: { opened_at?: string | null; created_at?: string | null }): string | null {
  return position.opened_at ?? position.created_at ?? null;
}
