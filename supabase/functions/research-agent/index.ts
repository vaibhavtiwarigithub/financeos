// RETIRED 2026-07-31.
//
// Research scoring has one authoritative implementation:
//   POST /api/agents/research/cron -> lib/research-agent.ts
//
// This Edge Function previously carried a second scorer with different weights,
// provider defaults, market handling, and an LLM-controlled direction. Keeping
// it executable risked writing incompatible signals if a stale caller invoked it.

Deno.serve(() => new Response(JSON.stringify({
  error: "research-agent Edge Function retired",
  canonical_endpoint: "/api/agents/research/cron",
}), {
  status: 410,
  headers: { "Content-Type": "application/json" },
}));
