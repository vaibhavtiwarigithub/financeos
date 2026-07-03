-- Migration 046: RPC for semantic search over trade_decision_embeddings.
-- Called by LearnerAgent's semantic_search_decisions tool.
-- Returns top-K decisions ordered by cosine similarity to a query embedding.

CREATE OR REPLACE FUNCTION semantic_search_trade_decisions(
  query_embedding vector(1024),
  match_count     int DEFAULT 8
)
RETURNS TABLE (
  trade_decision_id uuid,
  content_text      text,
  similarity        float,
  symbol            text,
  action            text,
  exec_date         text,
  outcome_score     float,
  macro_market_regime text,
  pattern_tags      text[]
)
LANGUAGE sql STABLE SECURITY DEFINER
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
  FROM trade_decision_embeddings e
  JOIN trade_decisions d ON d.id = e.trade_decision_id
  ORDER BY e.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- Grant to authenticated and service_role
GRANT EXECUTE ON FUNCTION semantic_search_trade_decisions(vector, int) TO authenticated, service_role;
