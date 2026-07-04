-- Migration 047: harden RAG RPCs + scalable candidate selection
-- Addresses code-review findings:
--   #6  clamp match_count so LIMIT can't be NULL / negative / unbounded
--   #7  SECURITY INVOKER + fixed search_path (no RLS bypass, no search-path hijack)
--   #9  candidate selection via NOT EXISTS in SQL (no unbounded in-memory id set)

-- ── Semantic search: re-create with INVOKER rights + clamped limit ───────────
-- authenticated already holds SELECT on both tables via RLS, so INVOKER is safe
-- and correctly enforces row-level security for the caller.
DROP FUNCTION IF EXISTS semantic_search_trade_decisions(vector, int);

CREATE FUNCTION semantic_search_trade_decisions(
  query_embedding vector(1024),
  match_count     int DEFAULT 8
)
RETURNS TABLE (
  trade_decision_id   uuid,
  content_text        text,
  similarity          float,
  symbol              text,
  action              text,
  exec_date           text,
  outcome_score       float,
  macro_market_regime text,
  pattern_tags        text[]
)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, public, extensions
AS $$
  SELECT
    e.trade_decision_id,
    e.content_text,
    1 - (e.embedding <=> query_embedding) AS similarity,
    d.symbol,
    d.action,
    d.exec_date::text,
    d.outcome_score,
    d.macro_market_regime,
    d.pattern_tags
  FROM public.trade_decision_embeddings e
  JOIN public.trade_decisions d ON d.id = e.trade_decision_id
  ORDER BY e.embedding <=> query_embedding
  LIMIT LEAST(GREATEST(COALESCE(match_count, 8), 1), 20);
$$;

GRANT EXECUTE ON FUNCTION semantic_search_trade_decisions(vector, int) TO authenticated, service_role;

-- ── Candidate selection: enriched decisions with no embedding yet ────────────
-- Replaces the route's load-all-ids-then-filter-in-JS approach. Bounded,
-- deterministic, index-friendly. Returns full trade_decisions rows.
CREATE OR REPLACE FUNCTION unembedded_trade_decisions(match_count int DEFAULT 50)
RETURNS SETOF trade_decisions
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, public, extensions
AS $$
  SELECT d.*
  FROM public.trade_decisions d
  WHERE d.enrichment_status = 'enriched'
    AND NOT EXISTS (
      SELECT 1 FROM public.trade_decision_embeddings e
      WHERE e.trade_decision_id = d.id
    )
  ORDER BY d.exec_date DESC NULLS LAST
  LIMIT LEAST(GREATEST(COALESCE(match_count, 50), 1), 500);
$$;

GRANT EXECUTE ON FUNCTION unembedded_trade_decisions(int) TO authenticated, service_role;
