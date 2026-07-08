-- Migration 123 — Durable RAG re-ingest (Codex review P1-1)
--
-- Problem: lib/rag/ingest.ts deleted all chunks for a source_id BEFORE inserting
-- the replacement set. If the insert then failed (embedding/provider/schema),
-- the document vanished from retrieval — evidence memory silently lost.
--
-- Fix: version the chunks. New re-ingest writes a NEW ingest_version (active=true)
-- and only removes the prior version AFTER the insert succeeds. A failed re-ingest
-- leaves the prior active version fully retrievable. Retrieval reads active rows
-- only. All additive; safe to re-run.

alter table doc_chunks add column if not exists ingest_version int not null default 1;
alter table doc_chunks add column if not exists active boolean not null default true;

-- The old unique(source_id, chunk_index) forbids two versions of the same source
-- coexisting (needed during the insert-new-before-drop-old swap). Replace it with
-- a version-scoped uniqueness. Drop by conventional name; guard if already gone.
alter table doc_chunks drop constraint if exists doc_chunks_source_id_chunk_index_key;
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'doc_chunks_source_version_chunk_key'
  ) then
    alter table doc_chunks
      add constraint doc_chunks_source_version_chunk_key
      unique (source_id, ingest_version, chunk_index);
  end if;
end $$;

-- Partial index to make "active chunks for a source" and retrieval-time active
-- filtering cheap.
create index if not exists doc_chunks_active_source_idx
  on doc_chunks (source_id) where active;

-- Retrieval must only see the active version. Adds `and c.active` to the WHERE.
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
    and c.active
    and (filter_symbol is null or c.symbol = filter_symbol)
    and (filter_market is null or c.market = filter_market)
  order by c.embedding <=> query_embedding
  limit greatest(match_count, 1);
$$;
