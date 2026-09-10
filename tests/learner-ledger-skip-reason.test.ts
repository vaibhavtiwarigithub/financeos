import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const learner = readFileSync(join(process.cwd(), "app/api/agents/learner/route.ts"), "utf8");

// THE DEFECT THIS GUARDS.
//
// computeScoreCorrelation tries the observation ledger, then falls back to a
// legacy paper_trades join. The fallback selects the 100 NEWEST signals and
// joins them to closed trades — at a 10-day horizon those signals cannot have
// matured, so it returns n<=1 forever. update_signal_weight refuses any source
// except the ledger, so once the ledger read fails the run cannot produce a
// challenger no matter what the LLM concludes.
//
// The ledger failure was swallowed by a bare `catch {}`. Measured 2026-09-04:
// the US run at 07:30Z threw on the pre-batching oversized `.in()` read and
// reported "Insufficient data, n=1" for all six dimensions while 2,338 matured
// US h10 labels existed. `learner_runs` recorded hypotheses:[] and
// weight_mutations:[] — identical to an honest "nothing worth changing". The
// read was fixed 33 minutes later (2e5021ba); the seam that hid it was not.
describe("a failed ledger read cannot masquerade as an empty cohort", () => {
  const fnStart = learner.indexOf("async function computeScoreCorrelation(");
  const fnEnd = learner.indexOf("async function toolExecutor(", fnStart);
  // A missing anchor makes indexOf return -1 and slice widen silently, so the
  // assertions below would pass without reading the function at all.
  it("brackets the function it claims to test", () => {
    expect(fnStart).toBeGreaterThan(-1);
    expect(fnEnd).toBeGreaterThan(fnStart);
  });

  const fn = learner.slice(fnStart, fnEnd);

  it("no longer swallows the ledger exception", () => {
    expect(fn).not.toMatch(/catch\s*\{\s*\/\*/);
    expect(fn).toContain("catch (ledgerErr)");
  });

  it("raises a health alert when the ledger read throws", () => {
    expect(fn).toContain("learner-ledger-read-failed:");
    expect(fn).toContain('severity: "critical"');
  });

  it("names a reason on every path that skips the ledger", () => {
    // throw, too-few-rows, and too-few-usable-pairs must each set one.
    const assignments = fn.match(/ledgerSkipReason = /g) ?? [];
    expect(assignments.length).toBeGreaterThanOrEqual(3);
  });

  it("returns the reason to both callers rather than dropping it", () => {
    expect(fn).toContain('return { source: "insufficient_data", n: 0, correlation: 0, ledgerSkipReason }');
    // the read-only diagnostic tool
    expect(learner).toContain("ledger_skip_reason: result.ledgerSkipReason");
    // the gate that actually refuses the weight change
    expect(learner).toContain("reason=${evidence.ledgerSkipReason");
  });

  // REMOVED 2026-09-09. The legacy paper_trades fallback read the 100 NEWEST
  // agent_signals and joined them to closed paper_trades — at a 10-day horizon
  // those signals cannot have matured, so it returned n<=1 by construction
  // (measured: 0 usable pairs). update_signal_weight always refused it as a
  // mutation source anyway, so its only effect was to dress a broken ledger
  // read as "insufficient data". A skipped ledger now says so directly.
  it("no longer has a paper_trades fallback that can mask a broken ledger read", () => {
    expect(fn).not.toContain("paper_trades_fallback");
    expect(fn).not.toContain("applyLearningTaintFilter");
    // insufficient_data is now the ONLY non-ledger outcome
    expect(fn).not.toMatch(/source:\s*"(?!observation_ledger|insufficient_data)/);
  });
});
