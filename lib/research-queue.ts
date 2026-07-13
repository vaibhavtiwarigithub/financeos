// Research carry-forward queue (migration 172). Candidates that don't fit a
// run's cap are deferred here and given HIGHER priority next run, so a growing
// watchlist/screener pool rotates through fairly instead of silently dropping
// overflow. Holdings are NEVER queued — they're always scored (exit safety).
//
// All ops are best-effort: a queue error must never break a research run.

type Svc = any;

/** Symbols carried forward for this market, highest-priority (longest-waiting) first. */
export async function readDeferredCandidates(svc: Svc, market: "us" | "india"): Promise<string[]> {
  try {
    const { data } = await svc
      .from("research_queue")
      .select("symbol")
      .eq("market", market)
      .order("priority", { ascending: false })
      .order("deferred_at", { ascending: true });
    return (data ?? []).map((r: any) => String(r.symbol).toUpperCase());
  } catch {
    return [];
  }
}

/**
 * Take the top `cap` of an already-priority-ordered candidate symbol list to
 * process THIS run; carry the overflow forward (priority+1, attempts+1 so it
 * can't starve); and clear any queued symbol that made it into this batch.
 * Returns the symbols to process now.
 */
export async function applyCandidateCarryForward(
  svc: Svc,
  market: "us" | "india",
  orderedSymbols: string[],
  cap: number,
): Promise<string[]> {
  const batch = orderedSymbols.slice(0, Math.max(0, cap));
  const overflow = orderedSymbols.slice(Math.max(0, cap));
  try {
    if (batch.length > 0) {
      await svc.from("research_queue").delete().eq("market", market).in("symbol", batch);
    }
    if (overflow.length > 0) {
      const { data: existing } = await svc
        .from("research_queue")
        .select("symbol, priority, attempts")
        .eq("market", market)
        .in("symbol", overflow);
      const prev = new Map<string, { priority: number; attempts: number }>(
        (existing ?? []).map((r: any) => [
          String(r.symbol).toUpperCase(),
          { priority: Number(r.priority ?? 0), attempts: Number(r.attempts ?? 0) },
        ] as [string, { priority: number; attempts: number }]),
      );
      const now = new Date().toISOString();
      const rows = overflow.map((symbol) => {
        const p = prev.get(symbol);
        return {
          market,
          symbol,
          priority: (p?.priority ?? 0) + 1,
          attempts: (p?.attempts ?? 0) + 1,
          deferred_at: now,
        };
      });
      await svc.from("research_queue").upsert(rows, { onConflict: "market,symbol" });
    }
  } catch {
    // best-effort — fall through and just process the batch we sliced
  }
  return batch;
}
