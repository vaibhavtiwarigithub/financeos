// lib/rag/ingest.ts — document ingestion pipeline (Tier-4 #16)
//
// LlamaIndex's core value is a pluggable ingestion pipeline:
//   source → chunk (node parser) → transform (context) → embed → store (vector index)
// This file is that pipeline, native, composed from primitives we already own:
//   chunk()             — sentence-aware splitter with overlap
//   contextualizeChunks — #11 ticker filter + #12 Anthropic contextual header
//   embedTexts          — Jina jina-embeddings-v3
//   doc_chunks          — pgvector store (migration 120)
//
// Why native (not llamaindex.ts): LlamaIndex drags a large dependency tree and
// its own storage/embedding abstractions that duplicate what we built for
// trade-memory. The pipeline shape is the actual asset, and it's ~1 file here,
// sharing one embedding provider and one vector store with the rest of RAG. A
// real LlamaIndex reader (SEC, web) can still feed `ingestDocument` as a source.
//
// Fully gated: no JINA_API_KEY → ingest is a no-op returning {stored:0}.

import { createServiceClient } from "@/lib/supabase/service";
import { embedTexts, embeddingsEnabled, EMBEDDING_MODEL } from "./embeddings";
import { contextualizeChunks } from "./contextual";
import { rerank } from "./rerank";
import { embedText } from "./embeddings";
import { traceRag } from "@/lib/observability/weave";

export interface DocumentSource {
  /** Stable id for the document — re-ingesting the same id replaces its chunks. */
  sourceId: string;
  title?: string;
  symbol: string;
  market?: "us" | "india";
  text: string;
  metadata?: Record<string, unknown>;
}

export interface ChunkOpts {
  /** Target chunk size in characters. Default 1200 (~300 tokens). */
  size?: number;
  /** Overlap between adjacent chunks in characters. Default 150. */
  overlap?: number;
}

/**
 * Sentence-aware character splitter with overlap. Splits on sentence boundaries
 * where possible so chunks don't cut mid-sentence; falls back to hard cuts for
 * runaway sentences. Deterministic — no randomness.
 */
export function chunk(text: string, opts: ChunkOpts = {}): string[] {
  const size = opts.size ?? 1200;
  const overlap = opts.overlap ?? 150;
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= size) return clean ? [clean] : [];

  // Split into sentences, then greedily pack into size-bounded chunks.
  const sentences = clean.match(/[^.!?]+[.!?]+|\S+$/g) ?? [clean];
  const chunks: string[] = [];
  let cur = "";
  for (const s of sentences) {
    const sentence = s.trim();
    if (!sentence) continue;
    if (cur.length + sentence.length + 1 > size && cur) {
      chunks.push(cur.trim());
      // Start next chunk with a tail overlap of the previous for context continuity.
      cur = overlap > 0 ? cur.slice(Math.max(0, cur.length - overlap)) + " " : "";
    }
    // Hard-cut a single sentence longer than `size`.
    if (sentence.length > size) {
      for (let i = 0; i < sentence.length; i += size - overlap) {
        chunks.push(sentence.slice(i, i + size).trim());
      }
      cur = "";
    } else {
      cur += sentence + " ";
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.filter(Boolean);
}

export interface IngestResult {
  sourceId: string;
  chunks: number;
  filtered: number; // rejected by ticker filter
  stored: number;
  skipped?: string;
}

/**
 * Ingest one document into the doc_chunks store. Pipeline:
 * chunk → (#11 filter + #12 contextualize) → embed(document) → upsert.
 * Idempotent per sourceId: existing chunks for the source are deleted first.
 * No-op when embeddings are disabled.
 */
export async function ingestDocument(
  doc: DocumentSource,
  chunkOpts?: ChunkOpts
): Promise<IngestResult> {
  const base: IngestResult = {
    sourceId: doc.sourceId,
    chunks: 0,
    filtered: 0,
    stored: 0,
  };
  if (!embeddingsEnabled()) return { ...base, skipped: "embeddings disabled" };

  const started = Date.now();
  const market = doc.market ?? "us";
  const raw = chunk(doc.text, chunkOpts);
  base.chunks = raw.length;
  if (raw.length === 0) return { ...base, skipped: "empty document" };

  // #11 ticker filter + #12 contextual headers.
  const contextual = await contextualizeChunks(raw, {
    symbol: doc.symbol,
    market,
    docTitle: doc.title,
    source: "ingest",
  });
  base.filtered = raw.length - contextual.length;
  if (contextual.length === 0) return { ...base, skipped: "all chunks filtered out" };

  // Embed the contextualized text (that's what retrieval matches against).
  const vectors = await embedTexts(
    contextual.map((c) => c.contextual),
    "document"
  );
  if (!vectors) return { ...base, skipped: "embedding failed" };

  const svc = createServiceClient();
  // Durable re-ingest (migration 123): write a NEW active version, then drop the
  // prior version ONLY after the insert succeeds. A failed insert leaves the old
  // active chunks intact and retrievable — evidence memory is never lost.
  const { data: prior } = await svc
    .from("doc_chunks")
    .select("ingest_version")
    .eq("source_id", doc.sourceId)
    .order("ingest_version", { ascending: false })
    .limit(1);
  const priorVersion: number = (prior?.[0] as any)?.ingest_version ?? 0;
  const newVersion = priorVersion + 1;

  const rows = contextual.map((c, i) => ({
    source_id: doc.sourceId,
    doc_title: doc.title ?? null,
    symbol: doc.symbol,
    market,
    chunk_index: i,
    ingest_version: newVersion,
    active: true,
    text: c.text,
    contextual: c.contextual,
    metadata: doc.metadata ?? {},
    embed_model: EMBEDDING_MODEL,
    embedding: vectors[i],
  }));

  const { error } = await svc.from("doc_chunks").insert(rows);
  base.stored = error ? 0 : rows.length;

  // Only prune the old version after a confirmed successful insert.
  if (!error && priorVersion > 0) {
    await svc
      .from("doc_chunks")
      .delete()
      .eq("source_id", doc.sourceId)
      .neq("ingest_version", newVersion);
  }

  await traceRag({
    op: "index",
    source: "ingest",
    symbol: doc.symbol,
    market,
    span: {
      sourceId: doc.sourceId,
      chunks: base.chunks,
      filtered: base.filtered,
      stored: base.stored,
    },
    latencyMs: Date.now() - started,
    ok: !error,
    err: error?.message ?? null,
  });

  return base;
}

// ---- Retrieval from the doc store ------------------------------------------

export interface DocHit {
  source_id: string;
  doc_title: string | null;
  symbol: string;
  text: string;
  contextual: string;
  distance: number;
  rerankScore?: number;
}

/**
 * Retrieve the most relevant document chunks for a query about a symbol.
 * ANN over-fetch → Voyage rerank-2 → top-k. Empty when embeddings are off or the
 * store has nothing for the symbol.
 */
export async function retrieveDocChunks(opts: {
  query: string;
  symbol?: string | null;
  market?: "us" | "india" | null;
  k?: number;
  overfetch?: number;
}): Promise<DocHit[]> {
  const { query, symbol = null, market = null, k = 6, overfetch = 20 } = opts;
  if (!embeddingsEnabled()) return [];

  const qvec = await embedText(query, "query");
  if (!qvec) return [];

  const svc = createServiceClient();
  const { data, error } = await svc.rpc("match_doc_chunks", {
    query_embedding: qvec,
    match_count: overfetch,
    filter_symbol: symbol,
    filter_market: market,
  });
  if (error || !Array.isArray(data) || data.length === 0) return [];

  const candidates = data as DocHit[];
  const ranked = await rerank(query, candidates, (c) => c.contextual, k);
  return ranked.map((r) => ({ ...r.item, rerankScore: r.score }));
}
