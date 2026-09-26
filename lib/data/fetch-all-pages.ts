type PageResult<T> = {
  data: T[] | null;
  error: { message: string } | null;
};

/** Fetches a complete Supabase/PostgREST result despite the server's row cap. */
export async function fetchAllPages<T>(
  fetchPage: (from: number, to: number) => PromiseLike<PageResult<T>>,
  pageSize = 1000,
): Promise<{ data: T[]; error: { message: string } | null }> {
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error("pageSize must be a positive integer");
  }

  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const page = await fetchPage(from, from + pageSize - 1);
    if (page.error) return { data: [], error: page.error };
    const batch = page.data ?? [];
    rows.push(...batch);
    if (batch.length < pageSize) return { data: rows, error: null };
  }
}
