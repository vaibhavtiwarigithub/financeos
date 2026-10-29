-- Restore the original agent_memory baseline that is present in production
-- (Supabase migration 20260629224253 / 021_agent_memory) but was missing from
-- the tracked migration chain. Keep this idempotent for projects where that
-- historical migration has already run.

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS public.agent_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_type TEXT NOT NULL,
  memory_type TEXT NOT NULL,
  symbol TEXT,
  content TEXT NOT NULL,
  embedding extensions.vector(1536),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS agent_memory_agent_type_idx
  ON public.agent_memory (agent_type);
CREATE INDEX IF NOT EXISTS agent_memory_memory_type_idx
  ON public.agent_memory (memory_type);
CREATE INDEX IF NOT EXISTS agent_memory_symbol_idx
  ON public.agent_memory (symbol) WHERE symbol IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_memory_embedding_idx
  ON public.agent_memory USING ivfflat (embedding extensions.vector_cosine_ops)
  WITH (lists = 100);

ALTER TABLE public.agent_memory ENABLE ROW LEVEL SECURITY;
