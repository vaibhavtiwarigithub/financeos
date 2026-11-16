-- Return bounded database-size telemetry to the existing authenticated cleanup
-- cron. This function reads catalog metadata only and never changes user data.
CREATE OR REPLACE FUNCTION public.get_database_storage_report()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_object(
    'database_bytes', pg_database_size(current_database()),
    'measured_at', statement_timestamp(),
    'top_relations', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'schema', relation_stats.schemaname,
        'name', relation_stats.relname,
        'bytes', relation_stats.total_bytes
      ) ORDER BY relation_stats.total_bytes DESC)
      FROM (
        SELECT namespace.nspname AS schemaname, relation.relname,
          pg_total_relation_size(relation.oid) AS total_bytes
        FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relkind IN ('r', 'm', 'p')
        ORDER BY total_bytes DESC
        LIMIT 10
      ) relation_stats
    ), '[]'::jsonb)
  );
$$;

REVOKE ALL ON FUNCTION public.get_database_storage_report() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_database_storage_report() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_database_storage_report() TO service_role;
