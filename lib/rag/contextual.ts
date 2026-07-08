// lib/rag/contextual.ts — Anthropic Contextual Retrieval + binary context filter
//   Tier-3 #12 (contextual retrieval) + Tier-3 #11 (binary ticker filter)
//
// Reusable primitive for DOCUMENT RAG (news, filings, earnings transcripts) keyed
// by a symbol — distinct from trade-history RAG (cross-symbol setups). Two ideas:
//
//   #11 Binary context filter (lib/ticker-filter.ts): before a chunk can enter
//       the LLM prompt, it MUST mention the target ticker. Entity-swapped chunks
//       (an MSFT paragraph retrieved for an NVDA query) pass every RAG evaluator
//       but poison trading signals, so we reject them at the retrieval layer and
//       trace the keep/reject decision to rag_traces + Weave.
//
//   #12 Contextual Retrieval (Anthropic): each chunk is prepended with a short,
//       LLM-generated sentence situating it in its source document ("This is from
//       NVDA's Q3 FY25 10-Q, MD&A section, discussing data-center revenue"). This
//       context travels with the chunk into embedding + prompt, sharply improving
//       retrieval precision. Generated with the cheap 'summarize' tier; on failure
//       the chunk passes through unmodified (graceful degradation).
//
// Order matters: FILTER first (drop wrong-entity chunks cheaply), THEN
// contextualize only the survivors (LLM calls aren't wasted on rejects).

import { filterChunksByTicker } from "@/lib/ticker-filter";
import { callLLM } from "@/lib/llm-router";
import { traceRag } from "@/lib/observability/weave";

export interface ContextualChunk {
  /** Original chunk text. */
  text: string;
  /** Context-prepended text for embedding/prompt (== text if contextualization off/failed). */
  contextual: string;
}

export interface ContextualizeOpts {
  symbol: string;
  market?: string | null;
  /** Title/identity of the source document, e.g. "NVDA Q3 FY25 10-Q". */
  docTitle?: string;
  /** Require the ticker to appear (Tier-3 #11). Default true. */
  filter?: boolean;
  /** Generate per-chunk context headers (Tier-3 #12). Default true. */
  contextualize?: boolean;
  source?: string;
}

/**
 * Filter document chunks to those mentioning the ticker (#11), then prepend an
 * LLM context header to each survivor (#12). Returns the survivors as
 * ContextualChunk[]. Traces the binary filter decision.
 */
export async function contextualizeChunks(
  chunks: string[],
  opts: ContextualizeOpts
): Promise<ContextualChunk[]> {
  const {
    symbol,
    market = null,
    docTitle,
    filter = true,
    contextualize = true,
    source = "document-rag",
  } = opts;

  if (chunks.length === 0) return [];

  // ---- #11 binary ticker filter ----
  const kept = filter ? filterChunksByTicker(symbol, chunks) : chunks;
  const rejected = chunks.length - kept.length;

  await traceRag({
    op: "filter",
    source,
    symbol,
    market,
    span: { in: chunks.length, kept: kept.length },
    filter: {
      kept: kept.length,
      rejected,
      reasons: rejected > 0 ? ["ticker-not-mentioned"] : [],
    },
  });

  if (kept.length === 0) return [];
  if (!contextualize) {
    return kept.map((text) => ({ text, contextual: text }));
  }

  // ---- #12 contextual retrieval (per-chunk header) ----
  const out: ContextualChunk[] = [];
  for (const text of kept) {
    const header = await contextHeader(symbol, docTitle, text).catch(
      () => null
    );
    out.push({
      text,
      contextual: header ? `${header}\n\n${text}` : text,
    });
  }
  return out;
}

// One cheap LLM call → a single situating sentence. Returns null on any failure
// so the caller falls back to the raw chunk.
async function contextHeader(
  symbol: string,
  docTitle: string | undefined,
  chunk: string
): Promise<string | null> {
  const doc = docTitle ? `document "${docTitle}"` : "its source document";
  const res = await callLLM({
    task: "summarize",
    symbol,
    agentLabel: "rag-context",
    maxTokens: 80,
    systemPrompt:
      "You situate a text chunk within its source document for retrieval. " +
      "Output ONE short sentence (max 25 words) naming the company/ticker, the " +
      "document, and what this chunk is about. No preamble, no quotes.",
    prompt:
      `Ticker: ${symbol}\nFrom ${doc}.\n\nChunk:\n${chunk.slice(0, 1200)}\n\n` +
      `One-sentence context:`,
  });
  const t = (res.text || "").trim();
  return t.length > 0 ? t : null;
}
