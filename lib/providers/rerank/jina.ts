import { reportIssue } from "@/lib/system-health";
import type { RerankProvider, RerankHit } from "./types";

const JINA_URL = "https://api.jina.ai/v1/rerank";
const MODEL    = "jina-reranker-v2-base-multilingual";

export class JinaRerankProvider implements RerankProvider {
  readonly name = "jina";

  isAvailable(): boolean {
    const k = process.env.JINA_API_KEY;
    return !!(k && k.trim());
  }

  async rerank<T>(
    query: string,
    items: T[],
    toText: (item: T) => string,
    topK: number,
  ): Promise<RerankHit<T>[]> {
    const fallback = (): RerankHit<T>[] => items.slice(0, topK).map(item => ({ item, score: 0 }));
    const key = process.env.JINA_API_KEY?.trim();
    if (!key || items.length === 0) return fallback();

    try {
      const documents = items.map(toText);
      const res = await fetch(JINA_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
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
      const json = (await res.json()) as { results?: { index: number; relevance_score: number }[] };
      const data = json.results ?? [];
      if (data.length === 0) return fallback();
      return data
        .filter(d => items[d.index] !== undefined)
        .sort((a, b) => b.relevance_score - a.relevance_score)
        .slice(0, topK)
        .map(d => ({ item: items[d.index], score: d.relevance_score }));
    } catch (e) {
      await reportIssue({
        issueKey: "jina-rerank-failed",
        severity: "warn", category: "rag",
        title: "Jina rerank unavailable",
        detail: e instanceof Error ? e.message : String(e),
      }).catch(() => {});
      return fallback();
    }
  }
}
