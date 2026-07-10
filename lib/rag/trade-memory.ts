// lib/rag/trade-memory.ts — Trade-history RAG (Strategic Intelligence Tier-3 #10)
//
// "The last N times we took a setup like this, here is what happened."
//
// At research time, for a new candidate we build a query document from its
// current features and retrieve the most SIMILAR PAST CLOSED TRADES — across
// ALL symbols, not just the same ticker. Similar setups (scores, direction,
// discovery source, regime) cluster in embedding space regardless of which name
// they were. Their realized outcomes are summarized into the thesis prompt so
// the LLM reasons from what actually happened, not just current fundamentals.
//
// Corpus = closed paper_trades, minus anything tainted / excluded_from_learning
// (poisoned outcomes must never teach the retriever — enforced here at index
// time AND by the `excluded` guard in match_trade_memories, migration 118).
//
// Pipeline: pgvector ANN over-fetch (k≈20) → Jina reranker → top-k. Every
// step traces to rag_traces + WandB Weave. All steps degrade to no-op when
// JINA_API_KEY is absent (embeddingsEnabled() === false).

import { createServiceClient } from "@/lib/supabase/service";
import { embedText, embeddingsEnabled, EMBEDDING_MODEL } from "./embeddings";
import { rerank } from "./rerank";
import { traceRag } from "@/lib/observability/weave";

// ---- The setup document -----------------------------------------------------

/** Shape we need to build a setup document. Superset of paper_trades columns. */
export interface TradeSetup {
  symbol: string;
  market?: string | null;
  direction?: string | null;
  analyst_score?: number | null;
  fundamental_score?: number | null;
  technical_score?: number | null;
  sentiment_score?: number | null;
  macro_score?: number | null;
  discovery_source?: string | null;
  rationale?: string | null;
}

function band(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
  if (v >= 0.75) return "very high";
  if (v >= 0.6) return "high";
  if (v >= 0.45) return "moderate";
  if (v >= 0.3) return "low";
  return "very low";
}

/**
 * Deterministic natural-language description of a trade's ENTRY setup. Used for
 * both indexing (the stored document) and querying (a candidate's live setup),
 * so the two live in the same embedding space. Deliberately excludes outcome —
 * we retrieve by setup similarity, then read outcomes off the retrieved rows.
 */
export function buildSetupDocument(s: TradeSetup): string {
  const dir = (s.direction || "LONG").toUpperCase();
  const mkt = (s.market || "us").toUpperCase();
  const parts = [
    `${dir} setup in ${mkt} market.`,
    `Composite analyst conviction ${band(s.analyst_score)}.`,
    `Fundamentals ${band(s.fundamental_score)}, technicals ${band(
      s.technical_score
    )}, sentiment ${band(s.sentiment_score)}, macro ${band(s.macro_score)}.`,
    s.discovery_source ? `Discovered via ${s.discovery_source}.` : "",
    s.rationale ? `Thesis: ${s.rationale.slice(0, 500)}` : "",
  ];
  return parts.filter(Boolean).join(" ");
}

// ---- Indexing ---------------------------------------------------------------

/**
 * Index one CLOSED trade into trade_memories (upsert by trade_id). No-op if
 * embeddings are disabled, the trade isn't closed, or it's tainted/excluded.
 * Returns true if a memory row was written.
 */
export async function indexClosedTrade(tradeId: string): Promise<boolean> {
  if (!embeddingsEnabled()) return false;
  const svc = createServiceClient();
  const started = Date.now();

  const { data: t, error } = await svc
    .from("paper_trades")
    .select(
      "id, symbol, market, direction, outcome, pnl_pct, realized_pnl_pct, exit_reason, " +
        "analyst_score, fundamental_score, technical_score, sentiment_score, macro_score, " +
        "rationale, discovery_source, tainted, taint_reason, excluded_from_learning, closed_at"
    )
    .eq("id", tradeId)
    .maybeSingle();

  if (error || !t) return false;
  // Only closed trades have a realized outcome worth learning from.
  if (!t.outcome && !t.closed_at) return false;

  const excluded = Boolean(t.tainted) || Boolean(t.excluded_from_learning);
  const excludeReason = excluded
    ? t.taint_reason || "excluded_from_learning"
    : null;

  const doc = buildSetupDocument(t as TradeSetup);
  const vec = await embedText(doc, "document");
  if (!vec) return false;

  const pnlPct =
    t.pnl_pct ?? t.realized_pnl_pct ?? t.pnl_percent ?? null;

  const { error: upErr } = await svc.from("trade_memories").upsert(
    {
      trade_id: t.id,
      symbol: t.symbol,
      market: t.market || "us",
      direction: t.direction,
      setup_text: doc,
      outcome: t.outcome,
      pnl_pct: pnlPct,
      exit_reason: t.exit_reason,
      analyst_score: t.analyst_score,
      fundamental_score: t.fundamental_score,
      technical_score: t.technical_score,
      sentiment_score: t.sentiment_score,
      macro_score: t.macro_score,
      discovery_source: t.discovery_source,
      excluded,
      exclude_reason: excludeReason,
      embed_model: EMBEDDING_MODEL,
      embedding: vec,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "trade_id" }
  );

  await traceRag({
    op: "index",
    source: "index-on-close",
    symbol: t.symbol,
    market: t.market || "us",
    span: { tradeId, excluded, docLen: doc.length },
    latencyMs: Date.now() - started,
    ok: !upErr,
    err: upErr?.message ?? null,
  });

  return !upErr;
}

// ---- Retrieval --------------------------------------------------------------

export interface SimilarTrade {
  trade_id: string;
  symbol: string;
  market: string;
  direction: string | null;
  setup_text: string;
  outcome: string | null;
  pnl_pct: number | null;
  exit_reason: string | null;
  analyst_score: number | null;
  discovery_source: string | null;
  distance: number;
  rerankScore?: number;
}

export interface RetrieveOpts {
  /** Candidate's live setup — the query. */
  setup: TradeSetup;
  /** Restrict corpus to one market (US vs India cohorts stay separate). */
  market?: string | null;
  /** How many memories to return after rerank. Default 5. */
  k?: number;
  /** ANN over-fetch before rerank. Default 20. */
  overfetch?: number;
  source?: string;
}

/**
 * Retrieve the most similar past closed trades to a candidate's setup.
 * Two-stage: pgvector ANN (match_trade_memories) → Voyage rerank-2 → top-k.
 * Returns [] when embeddings are disabled or nothing is indexed yet.
 */
export async function retrieveSimilarTrades(
  opts: RetrieveOpts
): Promise<SimilarTrade[]> {
  const { setup, market = null, k = 5, overfetch = 20, source = "research" } =
    opts;
  if (!embeddingsEnabled()) return [];

  const started = Date.now();
  const query = buildSetupDocument(setup);
  const qvec = await embedText(query, "query");
  if (!qvec) return [];

  const svc = createServiceClient();
  const { data, error } = await svc.rpc("match_trade_memories", {
    query_embedding: qvec,
    match_count: overfetch,
    filter_market: market,
  });

  if (error || !Array.isArray(data) || data.length === 0) {
    await traceRag({
      op: "retrieve",
      source,
      symbol: setup.symbol,
      market: market ?? setup.market ?? null,
      span: { k, overfetch, candidates: 0 },
      latencyMs: Date.now() - started,
      ok: !error,
      err: error?.message ?? null,
    });
    return [];
  }

  const candidates = data as SimilarTrade[];

  await traceRag({
    op: "retrieve",
    source,
    symbol: setup.symbol,
    market: market ?? setup.market ?? null,
    span: {
      k,
      overfetch,
      candidates: candidates.length,
      nearestDistance: candidates[0]?.distance ?? null,
    },
    latencyMs: Date.now() - started,
    ok: true,
  });

  // Rerank the over-fetched set jointly against the query (Tier-3 #9).
  const rerankStart = Date.now();
  const ranked = await rerank(
    query,
    candidates,
    (c) => c.setup_text,
    k
  );

  await traceRag({
    op: "rerank",
    source,
    symbol: setup.symbol,
    market: market ?? setup.market ?? null,
    span: {
      inCount: candidates.length,
      outCount: ranked.length,
      topScore: ranked[0]?.score ?? null,
    },
    latencyMs: Date.now() - rerankStart,
    ok: true,
  });

  return ranked.map((r) => ({ ...r.item, rerankScore: r.score }));
}

// ---- Summarization for the prompt ------------------------------------------

/**
 * Compact "prior similar setups & outcomes" block for the thesis prompt.
 * Empty string when there are no memories (caller omits the section entirely).
 */
export function summarizeMemories(memories: SimilarTrade[]): string {
  if (memories.length === 0) return "";
  const lines = memories.map((m, i) => {
    const pnl =
      m.pnl_pct === null || m.pnl_pct === undefined
        ? "pnl n/a"
        : `${m.pnl_pct >= 0 ? "+" : ""}${m.pnl_pct.toFixed(1)}%`;
    const out = m.outcome || "unknown";
    const dir = (m.direction || "LONG").toUpperCase();
    const src = m.discovery_source ? ` via ${m.discovery_source}` : "";
    return `${i + 1}. ${m.symbol} (${dir}${src}) → ${out}, ${pnl}${
      m.exit_reason ? ` [${m.exit_reason}]` : ""
    }`;
  });
  const wins = memories.filter((m) => (m.outcome || "").toLowerCase() === "win")
    .length;
  return (
    `Prior similar setups (${wins}/${memories.length} were wins):\n` +
    lines.join("\n")
  );
}
