// Entity-level ticker validation for retrieved text chunks.
//
// All five leading RAG evaluators (WandB Weave, TruLens, Ragas, DeepEval, UpTrain)
// fail on entity-swapped hard negatives: an MSFT context retrieved for an NVDA query
// passes every evaluator. For a trading system, poisoned context corrupts signals
// directly. This filter must live at the retrieval layer, not delegated to evaluators.
//
// Use wherever text chunks are assembled into LLM context:
//   - Future RAG retrieval (news chunks, filing excerpts, earnings transcripts)
//   - AV news article filtering (already handled per-article in social-sentiment.ts)
//   - Any batch-fetched document set keyed by symbol

/** Strip exchange suffix for comparison (.NS, .BO for Indian names). */
function baseSymbol(symbol: string): string {
  return symbol.replace(/\.(NS|BO|NYSE|NASDAQ)$/i, "").toUpperCase()
}

/**
 * Filter text chunks to only those that mention the target symbol.
 * Rejects chunks where neither the raw symbol nor its base (suffix-stripped) form
 * appears in the text. Logs rejection count to avoid silent data loss.
 *
 * @param symbol   The target ticker (e.g. "AAPL", "RELIANCE.NS")
 * @param chunks   Array of raw text chunks from retrieval
 * @param opts.minMentions  Minimum occurrences required (default 1)
 * @param opts.logRejections  Log how many chunks were rejected (default true)
 */
export function filterChunksByTicker(
  symbol: string,
  chunks: string[],
  opts: { minMentions?: number; logRejections?: boolean } = {}
): string[] {
  const { minMentions = 1, logRejections = true } = opts
  const sym = symbol.toUpperCase()
  const base = baseSymbol(symbol)
  const variants = Array.from(new Set([sym, base])).filter(Boolean)

  const filtered = chunks.filter(chunk => {
    const upper = chunk.toUpperCase()
    let count = 0
    for (const v of variants) {
      // Count non-overlapping occurrences via split
      count += upper.split(v).length - 1
    }
    return count >= minMentions
  })

  if (logRejections && filtered.length < chunks.length) {
    console.warn(
      `[ticker-filter] ${symbol}: rejected ${chunks.length - filtered.length}/${chunks.length} chunks ` +
      `(ticker not found with minMentions=${minMentions})`
    )
  }

  return filtered
}

/**
 * Validate a single text chunk — returns true if the symbol appears.
 * Convenience wrapper for individual chunk gates.
 */
export function chunkMentionsTicker(symbol: string, chunk: string, minMentions = 1): boolean {
  return filterChunksByTicker(symbol, [chunk], { minMentions, logRejections: false }).length > 0
}
