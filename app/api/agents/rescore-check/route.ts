// Compatibility alias for the former latest-signal rescore heuristic.
// The canonical implementation now measures immutable market-local research
// sessions and writes structured append-only evidence. It requires explicit market scope; callers must pass
// ?market=us or ?market=india; there is no global prose fallback.
export { dynamic, maxDuration, GET, POST } from "@/app/api/agents/score-price-divergence/route";
