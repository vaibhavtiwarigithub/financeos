// Transient Supabase failures, and how to survive one.
//
// WHY THIS EXISTS. On 2026-09-14 both edge jobs died to the same thing:
//
//   EdgeIC US:    "edge market status failed (us/signed_adx_14): Gateway Timeout"
//   EdgeIC INDIA: "edge market status failed (india/volume_breakout): Gateway Timeout"
//   EdgeScout:    "Universe=0" — the universe query hit the same timeout, but the
//                 error was swallowed into an empty array and reported as a DATA
//                 finding rather than an infrastructure failure.
//
// Neither job was wrong about its own logic. A single slow round-trip took out a
// whole run, and there were many round-trips to be unlucky in: EdgeIC upserted
// one row per edge, serially. `lib/supabase/paginate.ts` already had bounded
// retries for paginated reads and one route carried its own inline predicate;
// this is that idea shared, so a third copy does not drift from the first two.
//
// Retrying is only correct because every call site here is IDEMPOTENT — an
// upsert keyed on a unique constraint, or a read. Do not wrap a plain insert
// that would duplicate a row.

/**
 * Is this the infrastructure being slow, rather than the request being wrong?
 *
 * Deliberately narrow. A constraint violation, a permission error or a bad
 * column is a real defect and must fail loudly on the first attempt — retrying
 * those would turn a clear error into a slow one.
 */
export function isTransientSupabaseError(message: string | null | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    m.includes("gateway timeout") ||
    m.includes("statement timeout") ||
    m.includes("canceling statement due to statement timeout") ||
    m.includes("timeout") ||
    m.includes("fetch failed") ||
    m.includes("socket hang up") ||
    m.includes("econnreset") ||
    m.includes("service unavailable") ||
    m.includes("502") || m.includes("503") || m.includes("504")
  );
}

export type SupabaseResultLike = { error: { message: string } | null };

/**
 * Run an idempotent Supabase call, retrying only transient failures.
 *
 * Returns the last result rather than throwing, so the caller keeps whatever
 * error handling it already had; the difference is that a one-off timeout no
 * longer reaches that handler.
 */
export async function withSupabaseRetry<T extends SupabaseResultLike>(
  run: () => Promise<T>,
  opts: { retries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const retries = opts.retries ?? 2;
  const baseDelay = opts.delayMs ?? 400;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let result = await run();
  for (let attempt = 1; attempt <= retries; attempt++) {
    if (!result.error || !isTransientSupabaseError(result.error.message)) return result;
    // Linear backoff: these are seconds-scale gateway hiccups, not a thundering
    // herd, and a long exponential wait risks the route's own 290s budget.
    await sleep(baseDelay * attempt);
    result = await run();
  }
  return result;
}
