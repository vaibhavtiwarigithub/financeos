// Research carry-forward queue (migration 172). Candidates that don't fit a
// run's cap are deferred here and given HIGHER priority next run, so a growing
// watchlist/screener pool rotates through fairly instead of silently dropping
// overflow. Holdings are NEVER queued — they're always scored (exit safety).
//
// All ops are best-effort: a queue error must never break a research run.

type Svc = any;
const MAX_DEFER_ATTEMPTS = 6;

/**
 * A queued candidate keeps the source that DISCOVERED it.
 *
 * `research_queue.discovery_source` existed but was never written, and
 * `gatherSymbols` re-added every carried-forward symbol as "watchlist". A
 * screener candidate that overflowed the per-run cap therefore came back
 * relabelled, so `decision_observations.discovery_source` under-counted screener
 * discoveries and over-counted the watchlist. The "US screener 0 / watchlist 151"
 * reading that drove two alarms was partly this attribution bug, not only
 * starvation. Provenance has to survive the round trip or no discovery metric
 * can be trusted.
 */
export interface QueuedCandidate {
  symbol: string;
  /** null for rows queued before provenance was carried (pre-2026-08-04). */
  source: string | null;
}
const MAX_DEFER_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Symbols carried forward for this market, highest-priority (longest-waiting) first. */
export async function readDeferredCandidates(svc: Svc, market: "us" | "india"): Promise<QueuedCandidate[]> {
  try {
    const { data } = await svc
      .from("research_queue")
      .select("symbol, attempts, deferred_at, discovery_source")
      .eq("market", market)
      .order("priority", { ascending: false })
      .order("deferred_at", { ascending: true });
    const now = Date.now();
    const eligible: QueuedCandidate[] = [];
    const stale: string[] = [];
    for (const row of data ?? []) {
      const symbol = String((row as any).symbol).toUpperCase();
      const attempts = Number((row as any).attempts ?? 0);
      const deferredAt = Date.parse(String((row as any).deferred_at ?? ""));
      if (attempts >= MAX_DEFER_ATTEMPTS || !Number.isFinite(deferredAt) || now - deferredAt > MAX_DEFER_AGE_MS) stale.push(symbol);
      else eligible.push({ symbol, source: (row as any).discovery_source ?? null });
    }
    if (stale.length) await svc.from("research_queue").delete().eq("market", market).in("symbol", stale);
    return eligible;
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
/**
 * Re-defer symbols that WERE selected for this run but did not get processed —
 * e.g. the run hit its wall-clock budget before reaching them. Raises priority
 * (and attempts) so the NEXT run does them first. Best-effort; never throws.
 * This is what lets the research loop be time-bounded (never times out) without
 * dropping the tail: unprocessed names rotate to the front of the queue.
 */
export async function enqueueDeferred(
  svc: Svc,
  market: "us" | "india",
  symbols: string[],
  /** symbol -> discovery source, so a deferred screener name is not relabelled on return. */
  sourceOf: Map<string, string | null | undefined> = new Map(),
): Promise<void> {
  const list = [...new Set(symbols.map((s) => String(s).toUpperCase()))];
  if (list.length === 0) return;
  try {
    const { data: existing } = await svc
      .from("research_queue")
      .select("symbol, priority, attempts, deferred_at, discovery_source")
      .eq("market", market)
      .in("symbol", list);
    const prev = new Map<string, { priority: number; attempts: number; deferredAt: string; source: string | null }>(
      (existing ?? []).map((r: any) => [
        String(r.symbol).toUpperCase(),
        { priority: Number(r.priority ?? 0), attempts: Number(r.attempts ?? 0), deferredAt: String(r.deferred_at ?? ""), source: r.discovery_source ?? null },
      ] as [string, { priority: number; attempts: number; deferredAt: string; source: string | null }]),
    );
    const now = new Date().toISOString();
    const rows = list.map((symbol) => {
      const p = prev.get(symbol);
      return {
        market, symbol,
        priority: (p?.priority ?? 0) + 1,
        attempts: (p?.attempts ?? 0) + 1,
        deferred_at: p?.deferredAt || now,
        // Never overwrite a known source with null on a re-defer.
        discovery_source: sourceOf.get(symbol) ?? p?.source ?? null,
      };
    });
    const { error } = await svc.from("research_queue").upsert(rows, { onConflict: "market,symbol" });
    if (error) console.error("[research-queue] failed to re-defer budget tail:", error.message);
  } catch {
    /* best-effort — a queue write must never break the research run */
  }
}

/** Remove queue rows only after the selected symbols actually completed. */
export async function completeDeferred(
  svc: Svc,
  market: "us" | "india",
  symbols: string[],
): Promise<void> {
  const list = [...new Set(symbols.map((s) => String(s).toUpperCase()))];
  if (list.length === 0) return;
  try {
    await svc.from("research_queue").delete().eq("market", market).in("symbol", list);
  } catch {
    /* best-effort */
  }
}

export async function applyCandidateCarryForward(
  svc: Svc,
  market: "us" | "india",
  orderedSymbols: string[],
  cap: number,
  /** symbol -> discovery source. Overflow keeps its provenance instead of
   *  returning as a generic "watchlist" candidate on the next run. */
  sourceOf: Map<string, string | null | undefined> = new Map(),
): Promise<string[]> {
  const batch = orderedSymbols.slice(0, Math.max(0, cap));
  const overflow = orderedSymbols.slice(Math.max(0, cap));
  try {
    // Keep selected queued rows until the cron confirms success. Removing them
    // here reset `attempts` to one on every timeout and made MAX_DEFER_ATTEMPTS
    // ineffective for permanently failing symbols.
    if (overflow.length > 0) {
      const { data: existing } = await svc
        .from("research_queue")
        .select("symbol, priority, attempts, deferred_at, discovery_source")
        .eq("market", market)
        .in("symbol", overflow);
      const prev = new Map<string, { priority: number; attempts: number; deferredAt: string; source: string | null }>(
        (existing ?? []).map((r: any) => [
          String(r.symbol).toUpperCase(),
          { priority: Number(r.priority ?? 0), attempts: Number(r.attempts ?? 0), deferredAt: String(r.deferred_at ?? ""), source: r.discovery_source ?? null },
        ] as [string, { priority: number; attempts: number; deferredAt: string; source: string | null }]),
      );
      const now = new Date().toISOString();
      const rows = overflow.map((symbol) => {
        const p = prev.get(symbol);
        return {
          market,
          symbol,
          priority: (p?.priority ?? 0) + 1,
          attempts: (p?.attempts ?? 0) + 1,
          deferred_at: p?.deferredAt || now,
          discovery_source: sourceOf.get(symbol) ?? p?.source ?? null,
        };
      });
      await svc.from("research_queue").upsert(rows, { onConflict: "market,symbol" });
    }
  } catch {
    // best-effort — fall through and just process the batch we sliced
  }
  return batch;
}
