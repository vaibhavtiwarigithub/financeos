import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const CRON = code(read("app/api/agents/research/cron/route.ts"));

// Production, 2026-09-14 15:24 — the critical alert this fixes:
//   "research:us (us) partial: eligible=103 succeeded=64 expected_skip=0
//    deferred=37 unavailable=0 failed=2"
// The two "failures" were IAU and EPI hitting the 30s per-symbol budget. A
// symbol the budget never REACHED counted as deferred and passed quietly, while
// one that got 29 seconds counted as failed and escalated the run to critical.
// Both are capacity outcomes. The failing set varies run to run (TGT, MRK,
// SMCI, RBLX, ARM, GDX, VOR, QFIN, BBWI, DELL, INDY…), which is a latency
// ceiling rather than a broken symbol.

describe("a per-symbol timeout defers, it does not fail the run", () => {
  it("throws a distinguishable error rather than a bare Error", () => {
    expect(CRON.includes("class SymbolTimeoutError extends Error")).toBe(true);
    expect(CRON.includes("reject(new SymbolTimeoutError(label, ms))")).toBe(true);
  });

  it("leaves results[i] unset on timeout, so the deferred path re-queues it", () => {
    expect(CRON.includes("if (e instanceof SymbolTimeoutError)")).toBe(true);
    const branch = CRON.slice(CRON.indexOf("if (e instanceof SymbolTimeoutError)"),
                              CRON.indexOf("} else {", CRON.indexOf("if (e instanceof SymbolTimeoutError)")));
    // Assigning results[i] here is exactly what made a slow symbol critical.
    expect(/results\[i\]\s*=/.test(branch), "timeout branch still records an error").toBe(false);
    expect(branch.includes("timedOutSymbols.push(entry.symbol)")).toBe(true);
  });

  it("still fails the run for a GENUINE error", () => {
    // A provider returning garbage, or the LLM failing, must remain a failure —
    // otherwise this fix would hide real faults instead of reclassifying one.
    const elseBranch = CRON.slice(CRON.indexOf("} else {", CRON.indexOf("if (e instanceof SymbolTimeoutError)")));
    expect(elseBranch.includes("results[i] = { symbol: entry.symbol, error:")).toBe(true);
  });

  it("counts only real errors as failed in run accounting", () => {
    expect(CRON.includes("const errs = results.filter(r => r && r.error).length")).toBe(true);
    expect(CRON.includes("failed: errs")).toBe(true);
  });
});

describe("deferring a timeout does not make it invisible", () => {
  it("raises its own warn naming the symbols", () => {
    expect(CRON.includes("research-symbol-timeouts:")).toBe(true);
    expect(CRON.includes("exceeded the ${PER_SYMBOL_TIMEOUT_MS}ms budget")).toBe(true);
    expect(CRON.includes("timedOutSymbols.slice(0, 20).join(\", \")")).toBe(true);
  });

  it("is a warn, not a critical — the run itself is healthy", () => {
    const block = CRON.slice(CRON.indexOf("const timeoutIssueKey"));
    expect(block.includes('severity: "warn"')).toBe(true);
    expect(block.includes('severity: "critical"')).toBe(false);
  });

  it("clears itself on a clean run, like every other self-healing alert", () => {
    expect(CRON.includes("resolveIssue(timeoutIssueKey, supabase)")).toBe(true);
  });

  it("records the symbols on the run row too, not only in an alert", () => {
    expect(CRON.includes("timed_out_symbols: timedOutSymbols")).toBe(true);
  });

  it("tells the reader what to do about a persistent one", () => {
    expect(CRON.includes("RESEARCH_SYMBOL_TIMEOUT_MS")).toBe(true);
  });
});
