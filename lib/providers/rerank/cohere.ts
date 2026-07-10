// Cohere Rerank v3.5 — set RERANK_PROVIDER=cohere + COHERE_API_KEY to activate.
import type { RerankProvider, RerankHit } from "./types";

export class CohereRerankProvider implements RerankProvider {
  readonly name = "cohere";

  isAvailable(): boolean {
    const k = process.env.COHERE_API_KEY;
    return !!(k && k.trim());
  }

  async rerank<T>(
    query: string,
    items: T[],
    toText: (item: T) => string,
    topK: number,
  ): Promise<RerankHit<T>[]> {
    const fallback = (): RerankHit<T>[] => items.slice(0, topK).map(item => ({ item, score: 0 }));
    const key = process.env.COHERE_API_KEY?.trim();
    if (!key || items.length === 0) return fallback();
    try {
      const documents = items.map(toText);
      const res = await fetch("https://api.cohere.com/v2/rerank", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          query,
          documents,
          model: "rerank-v3.5",
          top_n: Math.min(topK, documents.length),
          return_documents: false,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return fallback();
      const json = (await res.json()) as { results?: { index: number; relevance_score: number }[] };
      return (json.results ?? [])
        .sort((a, b) => b.relevance_score - a.relevance_score)
        .slice(0, topK)
        .map(d => ({ item: items[d.index], score: d.relevance_score }));
    } catch {
      return fallback();
    }
  }
}
