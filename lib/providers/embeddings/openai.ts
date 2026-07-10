// OpenAI text-embedding-3-small — 1024-dim (truncated via `dimensions` param to match pgvector column).
// Requires OPENAI_API_KEY. Set EMBEDDING_PROVIDER=openai to activate.
import type { EmbeddingProvider, EmbedInputType } from "./types";

const MODEL = "text-embedding-3-small";
const DIM   = 1024; // truncated from native 1536 via OpenAI `dimensions` param

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai";
  readonly dim  = DIM;

  isAvailable(): boolean {
    const k = process.env.OPENAI_API_KEY;
    return !!(k && k.trim());
  }

  async embed(texts: string[], _inputType: EmbedInputType): Promise<number[][] | null> {
    const key = process.env.OPENAI_API_KEY?.trim();
    if (!key || texts.length === 0) return texts.length === 0 ? [] : null;
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: MODEL, input: texts, dimensions: DIM }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { embedding: number[]; index: number }[] };
    const out = new Array<number[]>(texts.length);
    for (const d of json.data ?? []) out[d.index] = d.embedding;
    return out.every(Boolean) ? out : null;
  }
}
