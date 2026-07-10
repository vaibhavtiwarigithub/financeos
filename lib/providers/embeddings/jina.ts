import { reportIssue } from "@/lib/system-health";
import type { EmbeddingProvider, EmbedInputType } from "./types";

const JINA_URL = "https://api.jina.ai/v1/embeddings";
const MODEL = "jina-embeddings-v3";
const DIM = 1024;
const BATCH = 128;

const TASK: Record<EmbedInputType, string> = {
  document: "retrieval.passage",
  query:    "retrieval.query",
};

export class JinaEmbeddingProvider implements EmbeddingProvider {
  readonly name = "jina";
  readonly dim  = DIM;

  isAvailable(): boolean {
    const k = process.env.JINA_API_KEY;
    return !!(k && k.trim());
  }

  private key(): string | null {
    const k = process.env.JINA_API_KEY;
    return k && k.trim() ? k.trim() : null;
  }

  private async batch(texts: string[], inputType: EmbedInputType, key: string): Promise<number[][]> {
    const res = await fetch(JINA_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        input: texts,
        model: MODEL,
        task: TASK[inputType],
        dimensions: DIM,
        embedding_type: "float",
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`jina embed ${res.status}: ${detail.slice(0, 300)}`);
    }
    const json = (await res.json()) as { data?: { embedding: number[]; index: number }[] };
    const out = new Array<number[]>(texts.length);
    for (const d of json.data ?? []) out[d.index] = d.embedding;
    for (let i = 0; i < out.length; i++) {
      if (!out[i]) throw new Error(`jina: missing embedding at index ${i}`);
    }
    return out;
  }

  async embed(texts: string[], inputType: EmbedInputType): Promise<number[][] | null> {
    const key = this.key();
    if (!key) return null;
    if (texts.length === 0) return [];
    try {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += BATCH) {
        out.push(...(await this.batch(texts.slice(i, i + BATCH), inputType, key)));
      }
      return out;
    } catch (e) {
      await reportIssue({
        issueKey: "jina-embeddings-failed",
        severity: "warn", category: "rag",
        title: "Jina embeddings unavailable",
        detail: e instanceof Error ? e.message : String(e),
      }).catch(() => {});
      return null;
    }
  }
}
