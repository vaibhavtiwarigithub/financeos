import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

// Regression guard for the discovery-attribution bug.
//
// research_queue.discovery_source existed but was never written, and
// gatherSymbols re-added every carried-forward symbol as "watchlist". A screener
// candidate that overflowed the per-run cap came back relabelled, so
// decision_observations under-counted screener discoveries and over-counted the
// watchlist. Two alarms were built on that metric before the bug was found.
describe("research queue preserves discovery provenance", () => {
  const queue = read("lib/research-queue.ts");
  const agent = read("lib/research-agent.ts");
  const cron = read("app/api/agents/research/cron/route.ts");

  it("selects and writes discovery_source on every queue path", () => {
    expect(queue).toContain("symbol, attempts, deferred_at, discovery_source");
    // Both the cap-overflow path and the budget-tail path must persist it.
    expect(queue.match(/discovery_source: sourceOf\.get\(symbol\) \?\? p\?\.source \?\? null/g) ?? []).toHaveLength(2);
  });

  it("never overwrites a known source with null on re-defer", () => {
    // A re-defer without a source map must keep what the row already had,
    // otherwise provenance decays to null after one budget cut.
    expect(queue).toContain("sourceOf.get(symbol) ?? p?.source ?? null");
  });

  it("re-adds carried-forward candidates under their original source", () => {
    expect(agent).toContain('addCandidate(q.symbol, (q.source as DiscoverySource) ?? "watchlist")');
    // The old hardcoded relabel must be gone.
    expect(agent).not.toContain('for (const sym of deferredUs) addCandidate(sym, "watchlist")');
  });

  it("passes provenance from the cap and from the budget tail", () => {
    expect(agent).toContain("candidateCap, candidateSourceOf");
    expect(cron).toContain('enqueueDeferred(supabase, "us", usDef, entrySourceOf)');
    expect(cron).toContain("enqueueDeferred(supabase, queueMarket, failed, entrySourceOf)");
  });

  it("records the deployed scorer version with every new decision observation", () => {
    expect(agent).toContain("const RESEARCH_CODE_VERSION = process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA ?? null");
    expect(agent).toContain("code_version: RESEARCH_CODE_VERSION");
  });
});
