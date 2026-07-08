// lib/rag/rerank.ts — Voyage reranker (Strategic Intelligence Tier-3 #9)
//
// Two-stage retrieval: pgvector ANN over-fetches ~20 nearest neighbours (cheap,
// approximate), then a cross-encoder reranker re-scores each (query, document)
// pair jointly and keeps the top-k. The reranker sees query+doc together so it
// catches relevance the bi-encoder embedding misses.
//
// Model: Voyage rerank-2 (uses the same VOYAGE_API_KEY as embeddings — no extra
// provider). Chosen over HuggingFace gte-reranker to avoid a second key/vendor.
//
// Graceful degradation: if VOYAGE_API_KEY is absent OR the call fails, return
// the input order truncated to topK (identity rerank). Retrieval still works,
// just without the precision bump. Never throws.

import { reportIssue } from "@/lib/system-health";

const VOYAGE_RERANK_URL = "https://api.voyageai.com/v1/rerank";
const MODEL = "rerank-2";

function apiKey(): string | null {
  const k = process.env.VOYAGE_API_KEY;
  return k && k.trim() ? k.trim() : null;
}

export interface RerankHit<T> {
  item: T;
  /** Voyage relevance score in [0,1]; higher = more relevant. */
  score: number;
}

/**
 * Rerank `items` against `query` and return the top `topK`, most-relevant first.
 *
 * @param items    candidate objects (from the ANN over-fetch)
 * @param toText   projects each item to the text the reranker scores
 * @param topK     how many to keep after reranking
 *
 * On disabled/failed rerank, returns the first `topK` items in their original
 * order with score 0 (identity fallback).
 */
export async function rerank<T>(
  query: string,
  items: T[],
  toText: (item: T) => string,
  topK: number
): Promise<RerankHit<T>[]> {
  const fallback = (): RerankHit<T>[] =>
    items.slice(0, topK).map((item) => ({ item, score: 0 }));

  const key = apiKey();
  if (!key || items.length === 0) return fallback();

  const documents = items.map(toText);

  try {
    const res = await fetch(VOYAGE_RERANK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        query,
        documents,
        model: MODEL,
        top_k: Math.min(topK, documents.length),
        // We already hold the documents; no need for Voyage to echo them back.
        return_documents: false,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`voyage rerank ${res.status}: ${detail.slice(0, 300)}`);
    }

    const json = (await res.json()) as {
      data?: { index: number; relevance_score: number }[];
    };
    const data = json.data ?? [];
    if (data.length === 0) return fallback();

    // Voyage returns results already sorted by relevance desc when top_k is set,
    // but sort defensively so ordering never depends on server behaviour.
    return data
      .filter((d) => items[d.index] !== undefined)
      .sort((a, b) => b.relevance_score - a.relevance_score)
      .slice(0, topK)
      .map((d) => ({ item: items[d.index], score: d.relevance_score }));
  } catch (e) {
    await reportIssue({
      issueKey: "voyage-rerank-failed",
      severity: "warn",
      category: "rag",
      title: "Voyage rerank unavailable",
      detail: e instanceof Error ? e.message : String(e),
    }).catch(() => {});
    return fallback();
  }
}
