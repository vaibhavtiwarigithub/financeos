-- Migration 045: trade_decision_embeddings
-- RAG store for LearnerAgent semantic search over enriched trade history.
-- Uses Voyage finance-2 embeddings (1024-dim). HNSW index for ANN queries.
-- pgvector extension already enabled (confirmed 2026-07-03).

CREATE TABLE IF NOT EXISTS trade_decision_embeddings (
  id                  bigserial PRIMARY KEY,
  trade_decision_id   uuid NOT NULL REFERENCES trade_decisions(id) ON DELETE CASCADE,
  embedding           vector(1024) NOT NULL,
  content_text        text NOT NULL,           -- the text that was embedded (for debugging)
  content_hash        text NOT NULL,           -- SHA-256 of content_text (dedup key)
  model               text NOT NULL DEFAULT 'voyage-finance-2',
  embedded_at         timestamptz NOT NULL DEFAULT now()
);

-- One embedding per trade_decision (upsert by trade_decision_id)
CREATE UNIQUE INDEX IF NOT EXISTS trade_decision_embeddings_td_id ON trade_decision_embeddings (trade_decision_id);
-- HNSW index: faster ANN queries than IVFFlat; no training required; good for 10k-100k rows
CREATE INDEX IF NOT EXISTS trade_decision_embeddings_hnsw ON trade_decision_embeddings USING hnsw (embedding vector_cosine_ops);

-- RLS: same pattern as other agent tables
ALTER TABLE trade_decision_embeddings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_all_tde"  ON trade_decision_embeddings FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "auth_read_tde"    ON trade_decision_embeddings FOR SELECT TO authenticated USING (true);
