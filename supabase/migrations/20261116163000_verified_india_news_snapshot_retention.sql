-- Archive-backed retention for India news snapshots.
-- The only current batch reader uses a seven-day source window. This RPC allows
-- bounded deletion only after the caller supplies the exact archived cohort's
-- count, ID bounds, and ordered row digest.

CREATE OR REPLACE FUNCTION public.india_news_snapshots_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  -- The SECURITY DEFINER retention RPC below is owned by postgres and is the
  -- only application path allowed to delete a verified expired cohort. Updates
  -- remain prohibited for every role.
  IF TG_OP = 'DELETE' AND current_user = 'postgres' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'india_news_snapshots is append-only outside verified retention';
END;
$$;

CREATE OR REPLACE FUNCTION public.prune_archived_india_news_snapshots(
  p_cutoff timestamptz,
  p_expected_rows integer,
  p_expected_min_id bigint,
  p_expected_max_id bigint,
  p_expected_digest text
)
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
  deleted_rows bigint;
BEGIN
  IF p_cutoff IS NULL OR p_cutoff > transaction_timestamp() - interval '7 days'
    OR p_expected_rows IS NULL OR p_expected_rows < 1 OR p_expected_rows > 10000
    OR p_expected_min_id IS NULL OR p_expected_min_id < 1
    OR p_expected_max_id IS NULL OR p_expected_max_id < p_expected_min_id
    OR p_expected_digest !~ '^[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'invalid or non-expired archive cohort';
  END IF;

  SELECT count(*), min(s.id), max(s.id),
    md5(string_agg(md5(to_jsonb(s)::text), '' ORDER BY s.id))
  INTO actual_rows, actual_min_id, actual_max_id, actual_digest
  FROM public.india_news_snapshots AS s
  WHERE s.fetched_at < p_cutoff;

  IF actual_rows <> p_expected_rows OR actual_min_id <> p_expected_min_id
    OR actual_max_id <> p_expected_max_id OR actual_digest IS DISTINCT FROM p_expected_digest THEN
    RAISE EXCEPTION 'archive cohort no longer matches source: rows %, min %, max %, digest %',
      actual_rows, actual_min_id, actual_max_id, actual_digest;
  END IF;

  DELETE FROM public.india_news_snapshots WHERE fetched_at < p_cutoff;
  GET DIAGNOSTICS deleted_rows = ROW_COUNT;
  IF deleted_rows <> p_expected_rows THEN
    RAISE EXCEPTION 'archive cohort delete count changed: expected %, deleted %', p_expected_rows, deleted_rows;
  END IF;
  RETURN jsonb_build_object('deleted_rows', deleted_rows, 'min_id', actual_min_id,
    'max_id', actual_max_id, 'ordered_row_digest', actual_digest, 'cutoff', p_cutoff);
END;
$$;

ALTER FUNCTION public.prune_archived_india_news_snapshots(timestamptz, integer, bigint, bigint, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.prune_archived_india_news_snapshots(timestamptz, integer, bigint, bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prune_archived_india_news_snapshots(timestamptz, integer, bigint, bigint, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_archived_india_news_snapshots(timestamptz, integer, bigint, bigint, text) TO service_role;
