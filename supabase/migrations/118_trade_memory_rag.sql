-- Migration 118 — Trade-history RAG (Strategic Intelligence Tier-3 #10 + Tier-4 #13)
--
-- Vector-DB decision (Tier-4 #13): use pgvector in the EXISTING Supabase Postgres
-- (extension `vector` 0.8.0, already installed) rather than standing up a separate
-- Qdrant Cloud service. Zero new infra, zero new cost, one datastore to secure.
-- Can migrate to Qdrant later if corpus scale ever demands it.
--
-- Trade-history RAG (Tier-3 #10): at research time, for a new candidate we retrieve
-- the most SIMILAR PAST CLOSED TRADES (cross-symbol — similar setups, not just the
-- same ticker) and feed their realized outcomes into the thesis prompt:
--   "The last N times we took a setup like this, here is what happened."
-- The corpus is closed paper_trades, embedded via Voyage voyage-3.5 (1024-dim).
--
-- Learning-integrity coupling (mig 116/117): a trade that was tainted or excluded
-- from learning is ALSO excluded from the RAG corpus — poisoned-data outcomes must
-- not teach the retriever. Enforced at index time (lib/rag/trade-memory.ts) and
-- re-asserted by the `excluded_from_learning` mirror column here for auditability.

create extension if not exists vector with schema extensions;

create table if not exists trade_memories (
  id                uuid primary key default gen_random_uuid(),
  trade_id          uuid not null references paper_trades(id) on delete cascade,
  symbol            text not null,
  market            text not null default 'us',
  direction         text,                       -- LONG / SHORT
  -- The natural-language document that was embedded (deterministic, see buildSetupDocument).
  -- Stored so we can re-rank, display "why this was retrieved", and re-embed on model change.
  setup_text        text not null,
  -- Realized outcome, denormalized from paper_trades so retrieval needs no join.
  outcome           text,                        -- win / loss / breakeven
  pnl_pct           numeric,
  exit_reason       text,
  analyst_score     numeric,
  fundamental_score numeric,
  technical_score   numeric,
  sentiment_score   numeric,
  macro_score       numeric,
  discovery_source  text,                        -- mig 114 attribution, carried into memory
  -- Integrity mirror: true => this memory came from tainted/excluded data and must
  -- never be returned by the retriever. Kept as a column (not just a filter) so an
  -- audit can prove no poisoned outcome ever entered the corpus.
  excluded          boolean not null default false,
  exclude_reason    text,
  -- voyage-3.5 default output dim is 1024. If the embedding model changes, bump
  -- embed_model + re-embed (the setup_text is retained precisely to allow this).
  embed_model       text not null default 'voyage-3.5',
  embedding         extensions.vector(1024),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- One memory per trade; re-indexing upserts.
  unique (trade_id)
);

comment on table trade_memories is
  'Tier-3 #10 Trade-history RAG corpus: closed paper_trades embedded (Voyage voyage-3.5) for similar-setup retrieval at research time. Tainted/excluded-from-learning trades are never indexed (excluded=true guard).';

-- HNSW index for cosine similarity (voyage embeddings are normalized → cosine ~ dot).
-- HNSW over ivfflat: better recall at small-to-mid corpus size, no training step.
create index if not exists trade_memories_embedding_hnsw
  on trade_memories using hnsw (embedding extensions.vector_cosine_ops);

create index if not exists trade_memories_symbol_idx on trade_memories (symbol);
create index if not exists trade_memories_market_idx on trade_memories (market);

-- RLS: service-role only. RAG indexing + retrieval run server-side (crons, agents);
-- no client ever reads this table directly. Matches the append-only-ledger posture.
alter table trade_memories enable row level security;

drop policy if exists trade_memories_service_all on trade_memories;
create policy trade_memories_service_all on trade_memories
  for all to service_role using (true) with check (true);

-- Similar-setup retrieval RPC. Runs the ANN search in-DB (one round trip) and
-- returns cosine distance so the caller can threshold/rerank. Never returns
-- excluded memories. Optional market filter (US vs India cohorts stay isolated,
-- matching the per-market champion design).
create or replace function match_trade_memories(
  query_embedding extensions.vector(1024),
  match_count     int  default 20,
  filter_market   text default null
)
returns table (
  id                uuid,
  trade_id          uuid,
  symbol            text,
  market            text,
  direction         text,
  setup_text        text,
  outcome           text,
  pnl_pct           numeric,
  exit_reason       text,
  analyst_score     numeric,
  discovery_source  text,
  distance          float
)
language sql stable
as $$
  select
    m.id, m.trade_id, m.symbol, m.market, m.direction, m.setup_text,
    m.outcome, m.pnl_pct, m.exit_reason, m.analyst_score, m.discovery_source,
    (m.embedding <=> query_embedding) as distance
  from trade_memories m
  where m.excluded = false
    and m.embedding is not null
    and (filter_market is null or m.market = filter_market)
  order by m.embedding <=> query_embedding
  limit greatest(match_count, 1);
$$;

comment on function match_trade_memories is
  'ANN retrieval of similar closed trades by cosine distance. Excludes tainted/excluded memories. Overfetch (match_count~20) then rerank in app via Voyage rerank-2 (Tier-3 #9).';
