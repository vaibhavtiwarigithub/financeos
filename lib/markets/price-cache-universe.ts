// The pure idempotency decision for the daily price-cache fill. Split out of
// app/api/agents/price-cache-fill/route.ts because Next.js route files may only
// export route handlers — a non-handler export there fails the typed-routes build.
//
// The UNIVERSE list itself stays defined in the route (its source of truth); this
// module holds only the pure predicate, so the two can never drift.

/**
 * Should the daily fill skip because the whole universe already has `expected`?
 *
 * Pure so the invariant is testable: skip ONLY when EVERY universe symbol has the
 * session, never when a single marker does. A SPY-only probe froze XLK/QQQ/DIA a
 * session behind once an off-schedule run advanced SPY (prod, 2026-07-17).
 * `freshSymbols` = universe symbols whose latest cached date >= expected.
 */
export function shouldSkipFill(freshSymbols: Iterable<string>, universe: readonly string[]): boolean {
  const fresh = new Set(freshSymbols);
  return universe.every((s) => fresh.has(s));
}
