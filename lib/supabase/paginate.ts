// Read every row of a PostgREST query, not the first page of it.
//
// WHY THIS EXISTS
// `.limit(20000)` is NOT an error in PostgREST. The server silently caps the
// response at its own maximum (1,000 rows here) and returns success, so a
// truncated analysis looks identical to a complete one. Measured in production
// 2026-08-28: the dimension-diagnostics loader asked for 20,000 and received
// 1,000 — every US dimension IC ever recorded was computed on ~40% of the rows
// and half the calendar. India sat under the cap, which is exactly why the
// truncation stayed invisible in a cross-market read.
//
// ORDERING IS LOAD-BEARING. Without a total order over the paged column, rows
// can repeat across pages or be skipped entirely; `range()` is positional, and
// Postgres does not promise a stable order without ORDER BY. Every caller must
// order by something unique (`id` unless there is a better key).
//
// Use this for any read whose ROW COUNT affects a result. A genuinely bounded
// read (a display page, a "latest 50") should keep its explicit `.limit()`.

/** Hard stop so a runaway query cannot page forever. */
const MAX_PAGES = 200;
export const PAGE_SIZE = 1000;

/**
 * @param page builds the query for one window; must apply a stable `.order()`.
 *
 * Example:
 *   await fetchAllRows((from, to) =>
 *     svc.from("observation_labels").select("id,...")
 *        .eq("horizon_days", 10)
 *        .order("id", { ascending: true })
 *        .range(from, to));
 */
export async function fetchAllRows<T = any>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  label = "paginated read",
): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < MAX_PAGES; p++) {
    const from = p * PAGE_SIZE;
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${label} failed: ${error.message}`);
    const rows = data ?? [];
    out.push(...rows);
    // A short page is the last page. Equality with PAGE_SIZE is the only
    // signal PostgREST gives that more may remain.
    if (rows.length < PAGE_SIZE) return out;
  }
  throw new Error(`${label} exceeded ${MAX_PAGES} pages (${MAX_PAGES * PAGE_SIZE} rows); refusing to page further rather than return a silently partial result.`);
}
