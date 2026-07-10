// lib/rag/rerank.ts — Jina reranker (free tier, same key as embeddings)
//
// Two-stage retrieval: pgvector ANN over-fetches ~20 nearest neighbours, then
// a cross-encoder reranker re-scores each (query, document) pair jointly.
//
// Model: jina-reranker-v2-base-multilingual (uses the same JINA_API_KEY —
// no extra provider). Free tier via jina.ai, no CC required.
//
// Graceful degradation: if JINA_API_KEY is absent OR the call fails, return
// the input order truncated to topK (identity rerank). Never throws.

import { reportIssue } from "@/lib/system-health";

const JINA_RERANK_URL = "https://api.jina.ai/v1/rerank";
const MODEL = "jina-reranker-v2-base-multilingual";

function apiKey(): string | null {
  const k = process.env.JINA_API_KEY;
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
    const res = await fetch(JINA_RERANK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        query,
        documents,
        model: MODEL,
        top_n: Math.min(topK, documents.length),
        return_documents: false,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`jina rerank ${res.status}: ${detail.slice(0, 300)}`);
    }

    // Jina rerank response shape: { results: [{ index, relevance_score }] }
    const json = (await res.json()) as {
      results?: { index: number; relevance_score: number }[];
    };
    const data = json.results ?? [];
    if (data.length === 0) return fallback();

    return data
      .filter((d) => items[d.index] !== undefined)
      .sort((a, b) => b.relevance_score - a.relevance_score)
      .slice(0, topK)
      .map((d) => ({ item: items[d.index], score: d.relevance_score }));
  } catch (e) {
    await reportIssue({
      issueKey: "jina-rerank-failed",
      severity: "warn",
      category: "rag",
      title: "Jina rerank unavailable",
      detail: e instanceof Error ? e.message : String(e),
    }).catch(() => {});
    return fallback();
  }
}
