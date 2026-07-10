// lib/rag/embeddings.ts — thin façade over lib/providers/embeddings/
//
// Swap embedding vendor: set EMBEDDING_PROVIDER=jina|openai in env.
// Default: jina (free, 1M tokens/month, no CC — JINA_API_KEY).
// Add a vendor: call registerEmbeddingProvider() before any embed call.
//
// Graceful degradation: if the active provider has no API key, every function
// returns null and NEVER throws. Callers skip the RAG step rather than failing.

export type { EmbedInputType, EmbeddingProvider } from "@/lib/providers/embeddings";
export { getEmbeddingProvider, registerEmbeddingProvider } from "@/lib/providers/embeddings";

import { getEmbeddingProvider } from "@/lib/providers/embeddings";
import type { EmbedInputType } from "@/lib/providers/embeddings";

export function embeddingsEnabled(): boolean {
  return getEmbeddingProvider().isAvailable();
}

export async function embedTexts(
  texts: string[],
  inputType: EmbedInputType = "document",
): Promise<number[][] | null> {
  return getEmbeddingProvider().embed(texts, inputType);
}

export async function embedText(
  text: string,
  inputType: EmbedInputType = "document",
): Promise<number[] | null> {
  const out = await embedTexts([text], inputType);
  return out && out[0] ? out[0] : null;
}

export const EMBEDDING_DIM = 1024; // pgvector column width — all providers must match

// For display/logging. Reads active provider name from env.
export const EMBEDDING_MODEL = process.env.EMBEDDING_PROVIDER ?? "jina";

// Legacy alias — kept for any import that still references the Voyage key name.
export const VOYAGE_API_KEY_ENV = "JINA_API_KEY";
