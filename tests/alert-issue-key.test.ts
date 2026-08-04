import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Normalise CRLF — these are source-text assertions and a fresh Windows
// checkout can land the same bytes with different line endings.
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

// Regression guard for the stale-alert board.
//
// emitAlert did not write the issue_key column AT ALL, so every alert it
// emitted was unclearable by construction: resolveIssue() keys on issue_key, so
// nothing could ever close them. Eight "Research: N symbols failed" rows from
// late July sat permanently open, which is how a real warn gets lost in noise.
describe("agent alerts are clearable", () => {
  it("emitAlert writes issue_key and refreshes an open row instead of duplicating", () => {
    const src = read("lib/alerts/emit.ts");
    expect(src).toContain("issue_key?: string | null");
    expect(src).toContain("issue_key: input.issue_key ?? null");
    // Idempotency: with a key set, a second occurrence must update the open row,
    // not insert a second one against the partial unique index.
    expect(src).toContain('.eq("resolved", false)');
  });

  it("every research-cron alert carries a stable issue_key", () => {
    const src = read("app/api/agents/research/cron/route.ts");
    for (const key of ["research-deferred-holdings:", "research-deferred-screener:", "research-symbol-failures:"]) {
      expect(src).toContain(key);
    }
    // And each clears when its condition lifts — an alert that only ever opens
    // is the same defect in a different shape.
    expect(src).toContain("resolveIssue(deferredHoldingsKey");
    expect(src).toContain("resolveIssue(screenerDeferredKey");
  });
});
