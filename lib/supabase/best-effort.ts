/**
 * Best-effort write for logging/bookkeeping that must never break the caller.
 *
 * supabase-js query builders are thenables WITHOUT a `.catch()` method, so `svc.from(x).insert(y).catch(() => {})`
 * throws "TypeError: ... .catch is not a function" the moment it runs. That one-line pattern made every leveraged-door
 * run crash before its liveness row (11 days of silent failure), and was still present in the leveraged-live and
 * crypto-live crons (after a real fill!), the Kite order route (after a confirmed BUY), downside-hedge, edge-readiness
 * and benchmark-scorecard error paths. `await` the builder instead; a Postgrest failure resolves with `{ error }`
 * rather than rejecting, so both outcomes are logged here and neither is thrown.
 */
export async function bestEffort(query: PromiseLike<unknown>, label = "write"): Promise<void> {
  try {
    const result = (await query) as { error?: { message?: string } | null } | null;
    if (result && result.error) console.error(`[best-effort] ${label} failed: ${result.error.message ?? "unknown error"}`);
  } catch (error) {
    console.error(`[best-effort] ${label} threw: ${error instanceof Error ? error.message : String(error)}`);
  }
}
