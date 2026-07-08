// lib/rag/embeddings.ts — Voyage AI embeddings (Strategic Intelligence Tier-3 #10)
//
// Thin wrapper over the Voyage embeddings API used by Trade-history RAG and
// Anthropic Contextual Retrieval. voyage-3.5 → 1024-dim vectors (matches the
// `vector(1024)` column in migration 118).
//
// Graceful-degradation contract (codebase idiom — same as Langfuse in
// lib/llm-router.ts): if VOYAGE_API_KEY is absent, every function returns null
// and NEVER throws. Callers treat null as "no embeddings available" and skip
// the RAG step rather than failing the whole agent run.

import { reportIssue } from "@/lib/system-health";

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
const MODEL = "voyage-3.5";
const DIM = 1024;
// Voyage caps a single request at 1000 inputs / 320k tokens. Stay well under.
const BATCH = 128;

export type EmbedInputType = "document" | "query";

function apiKey(): string | null {
  const k = process.env.VOYAGE_API_KEY;
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
  const res = await fetch(VOYAGE_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      input: texts,
      model: MODEL,
      input_type: inputType,
      output_dimension: DIM,
      // Voyage default is float; be explicit so a server-side default change
      // can't silently alter vector scale.
      output_dtype: "float",
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`voyage ${res.status}: ${detail.slice(0, 300)}`);
  }

  const json = (await res.json()) as {
    data?: { embedding: number[]; index: number }[];
  };
  const data = json.data ?? [];
  // Voyage returns results in request order, but sort by index to be safe.
  const out = new Array<number[]>(texts.length);
  for (const d of data) out[d.index] = d.embedding;
  // Defensive: any hole means a malformed response.
  for (let i = 0; i < out.length; i++) {
    if (!out[i]) throw new Error(`voyage: missing embedding at index ${i}`);
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
    // Flag once for observability, then degrade to null. Do not throw — a
    // Voyage outage must not take down research/indexing.
    await reportIssue({
      issueKey: "voyage-embeddings-failed",
      severity: "warn",
      category: "rag",
      title: "Voyage embeddings unavailable",
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
