-- Migration 120 — Document RAG store (Tier-4 #16 ingestion target)
-- Chunked, contextualized, embedded document fragments (news, filings,
-- transcripts) keyed by symbol. Populated by lib/rag/ingest.ts. Retrieval
-- applies the same market cohort + ticker guardrails as trade memory.

create extension if not exists vector with schema extensions;

create table if not exists doc_chunks (
  id             bigint generated always as identity primary key,
  source_id      text not null,            -- stable id of the source document
  doc_title      text,
  symbol         text not null,
  market         text not null default 'us',
  chunk_index    int  not null,
  text           text not null,            -- raw chunk
  contextual     text not null,            -- context-prepended text (what was embedded)
  metadata       jsonb not null default '{}'::jsonb,
  embed_model    text not null default 'voyage-3.5',
  embedding      extensions.vector(1024),
  created_at     timestamptz not null default now(),
  unique (source_id, chunk_index)
);

comment on table doc_chunks is
  'Tier-4 #16 document RAG store: chunked+contextualized+embedded doc fragments keyed by symbol. Populated by lib/rag/ingest.ts (source->chunk->contextualize->embed->store).';

create index if not exists doc_chunks_embedding_hnsw
  on doc_chunks using hnsw (embedding extensions.vector_cosine_ops);
create index if not exists doc_chunks_symbol_idx on doc_chunks (symbol);
create index if not exists doc_chunks_source_idx on doc_chunks (source_id);

alter table doc_chunks enable row level security;
drop policy if exists doc_chunks_service_all on doc_chunks;
create policy doc_chunks_service_all on doc_chunks
  for all to service_role using (true) with check (true);

create or replace function match_doc_chunks(
  query_embedding extensions.vector(1024),
  match_count     int  default 20,
  filter_symbol   text default null,
  filter_market   text default null
)
returns table (
  id           bigint,
  source_id    text,
  doc_title    text,
  symbol       text,
  market       text,
  text         text,
  contextual   text,
  metadata     jsonb,
  distance     float
)
language sql stable
as $$
  select c.id, c.source_id, c.doc_title, c.symbol, c.market, c.text, c.contextual, c.metadata,
         (c.embedding <=> query_embedding) as distance
  from doc_chunks c
  where c.embedding is not null
    and (filter_symbol is null or c.symbol = filter_symbol)
    and (filter_market is null or c.market = filter_market)
  order by c.embedding <=> query_embedding
  limit greatest(match_count, 1);
$$;
