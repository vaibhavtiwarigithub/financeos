// lib/rag/rerank.ts — thin façade over lib/providers/rerank/
//
// Swap reranker: set RERANK_PROVIDER=jina|cohere in env.
// Default: jina (free, jina-reranker-v2-base-multilingual — same JINA_API_KEY).
// Add a vendor: call registerRerankProvider() before any rerank call.
//
// Graceful degradation: if provider has no key OR call fails, returns input
// truncated to topK (identity rerank). Never throws.

export type { RerankHit, RerankProvider } from "@/lib/providers/rerank";
export { getRerankProvider, registerRerankProvider } from "@/lib/providers/rerank";

import { getRerankProvider } from "@/lib/providers/rerank";
import type { RerankHit }   from "@/lib/providers/rerank";

export async function rerank<T>(
  query: string,
  items: T[],
  toText: (item: T) => string,
  topK: number,
): Promise<RerankHit<T>[]> {
  return getRerankProvider().rerank(query, items, toText, topK);
}
