import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const route = readFileSync("app/api/agents/dimension-diagnostics/route.ts", "utf8");
const diagnostic = readFileSync("lib/learning/dimension-diagnostics.ts", "utf8");
const codeVersion = readFileSync("lib/learning/code-version-ic.ts", "utf8");

describe("dimension IC source-session contract", () => {
  it("loads the market-local signal session and its validation proof", () => {
    expect(route).toContain('select("id,agent_label,market,session_validated,as_of_session")');
    expect(route).toContain("source?.market === market && source.sessionValidated === true");
    expect(route).toContain("source?.market === market ? source.asOfSession : null");
  });

  it("passes the same source-session proof to the code-version ledger without raw-return fallback", () => {
    expect(codeVersion).toContain('select("id,market,session_validated,as_of_session")');
    expect(codeVersion).toContain("sessionValidated: source?.market === market && source.validated === true");
    expect(codeVersion).toContain("benchmarkNeutralReturn: returnValue == null ? null : Number(returnValue)");
    expect(codeVersion).not.toContain("row.benchmark_neutral_return ?? row.fwd_return");
  });

  it("excludes unvalidated sessions from predictive IC but reports their quality cost", () => {
    expect(diagnostic).toContain("row.sessionValidated === true");
    expect(diagnostic).toContain("invalid_or_unknown_session_provenance");
    expect(diagnostic).toContain("ts: row.asOfSession!");
    expect(diagnostic).toContain('if (value == null || value === "") return null;');
  });
});
