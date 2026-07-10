// lib/rag/embeddings.ts — Jina AI embeddings (free tier, no CC required)
//
// Replaces Voyage AI. jina-embeddings-v3 → 1024-dim vectors (same dimension as
// the previous voyage-3.5, so the `vector(1024)` pgvector column needs no change).
//
// Free tier: 1M tokens/month via JINA_API_KEY (free account at jina.ai, no CC).
//
// Graceful-degradation contract: if JINA_API_KEY is absent, every function
// returns null and NEVER throws. Callers treat null as "no embeddings available"
// and skip the RAG step rather than failing the whole agent run.

import { reportIssue } from "@/lib/system-health";

const JINA_URL = "https://api.jina.ai/v1/embeddings";
const MODEL = "jina-embeddings-v3";
const DIM = 1024;
// Jina caps requests at 2048 inputs; stay well under.
const BATCH = 128;

export type EmbedInputType = "document" | "query";

// Jina uses asymmetric task types for retrieval (matches Voyage's document/query split).
const JINA_TASK: Record<EmbedInputType, string> = {
  document: "retrieval.passage",
  query: "retrieval.query",
};

function apiKey(): string | null {
  const k = process.env.JINA_API_KEY;
  return k && k.trim() ? k.trim() : null;
}

/** True when embeddings are configured. Callers gate RAG on this. */
export function embeddingsEnabled(): boolean {
  return apiKey() !== null;
}

async function embedBatch(
  texts: string[],
  inputType: EmbedInputType,
  key: string
): Promise<number[][]> {
  const res = await fetch(JINA_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      input: texts,
      model: MODEL,
      task: JINA_TASK[inputType],
      dimensions: DIM,
      embedding_type: "float",
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`jina embed ${res.status}: ${detail.slice(0, 300)}`);
  }

  const json = (await res.json()) as {
    data?: { embedding: number[]; index: number }[];
  };
  const data = json.data ?? [];
  // Jina returns results in request order; sort by index defensively.
  const out = new Array<number[]>(texts.length);
  for (const d of data) out[d.index] = d.embedding;
  for (let i = 0; i < out.length; i++) {
    if (!out[i]) throw new Error(`jina: missing embedding at index ${i}`);
  }
  return out;
}

/**
 * Embed an array of texts. Returns one 1024-dim vector per input, aligned by
 * position, or null if embeddings are disabled/failed (graceful degradation).
 *
 * @param inputType "document" for corpus text (indexing), "query" for the
 *   retrieval query. Voyage uses this to asymmetrically tune the vector space;
 *   mismatching it degrades recall.
 */
export async function embedTexts(
  texts: string[],
  inputType: EmbedInputType = "document"
): Promise<number[][] | null> {
  const key = apiKey();
  if (!key) return null;
  if (texts.length === 0) return [];

  try {
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const chunk = texts.slice(i, i + BATCH);
      results.push(...(await embedBatch(chunk, inputType, key)));
    }
    return results;
  } catch (e) {
    await reportIssue({
      issueKey: "jina-embeddings-failed",
      severity: "warn",
      category: "rag",
      title: "Jina embeddings unavailable",
      detail: e instanceof Error ? e.message : String(e),
    }).catch(() => {});
    return null;
  }
}

/** Convenience: embed a single text. Returns the vector or null. */
export async function embedText(
  text: string,
  inputType: EmbedInputType = "document"
): Promise<number[] | null> {
  const out = await embedTexts([text], inputType);
  return out && out[0] ? out[0] : null;
}

export const EMBEDDING_DIM = DIM;
export const EMBEDDING_MODEL = MODEL;
// Legacy alias — resolves any import that still references the old Voyage key name.
export const VOYAGE_API_KEY_ENV = "JINA_API_KEY";
