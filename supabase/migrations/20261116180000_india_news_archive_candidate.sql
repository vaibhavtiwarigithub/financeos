-- Return one exact, bounded source snapshot for the scheduled R2 archive job.
-- The row payload is capped at 10,000 records and is only exposed to service_role.
CREATE OR REPLACE FUNCTION public.get_india_news_snapshots_archive_candidate(p_cutoff timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET timezone = 'UTC'
AS $$
DECLARE
  actual_rows bigint;
  actual_min_id bigint;
  actual_max_id bigint;
  actual_digest text;
  row_payload jsonb;
BEGIN
  IF p_cutoff IS NULL OR p_cutoff > transaction_timestamp() - interval '7 days' THEN
    RAISE EXCEPTION 'archive cutoff must be at least seven days old';
  END IF;

  WITH cohort AS MATERIALIZED (
    SELECT s.id, to_jsonb(s) AS row_json
    FROM public.india_news_snapshots AS s
    WHERE s.fetched_at < p_cutoff
    ORDER BY s.id
    LIMIT 10001
  )
  SELECT count(*), min(id), max(id),
    md5(string_agg(md5(row_json::text), '' ORDER BY id)),
    jsonb_agg(row_json ORDER BY id)
  INTO actual_rows, actual_min_id, actual_max_id, actual_digest, row_payload
  FROM cohort;

  IF actual_rows > 10000 THEN
    RAISE EXCEPTION 'archive cohort exceeds the bounded 10,000-row limit';
  END IF;

  IF actual_rows = 0 THEN
    RETURN jsonb_build_object('cutoff', p_cutoff, 'row_count', 0, 'min_id', NULL,
      'max_id', NULL, 'ordered_row_digest', NULL, 'rows', '[]'::jsonb);
  END IF;

  RETURN jsonb_build_object(
    'cutoff', p_cutoff,
    'row_count', actual_rows,
    'min_id', actual_min_id,
    'max_id', actual_max_id,
    'ordered_row_digest', actual_digest,
    'rows', coalesce(row_payload, '[]'::jsonb)
  );
END;
$$;

ALTER FUNCTION public.get_india_news_snapshots_archive_candidate(timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_india_news_snapshots_archive_candidate(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_india_news_snapshots_archive_candidate(timestamptz) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_india_news_snapshots_archive_candidate(timestamptz) TO service_role;
