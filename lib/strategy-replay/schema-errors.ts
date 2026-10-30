const MISSING_SCHEMA_CODES = new Set(["42P01", "42883", "PGRST202", "PGRST205"]);

/** Supabase/Postgres signals that a required feature table or RPC is absent. */
export function isMissingStrategyLabSchemaObject(error: { code?: unknown } | null | undefined): boolean {
  return typeof error?.code === "string" && MISSING_SCHEMA_CODES.has(error.code);
}
