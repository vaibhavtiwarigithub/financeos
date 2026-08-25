import { describe, it, expect } from "vitest";
import {
  EXCLUDE_SHADOW_FILTER,
  SHADOW_EXECUTION_MODE,
  isShadowProposal,
} from "./proposal-status";

// Evaluate a PostgREST `or=(...)` filter body against a row, so this asserts
// the filter's SEMANTICS rather than its spelling. A string `toContain` check
// would pass against a filter that had been "simplified" to a bare .neq() —
// which is the exact regression this file exists to catch, because a bare
// `execution_mode <> 'autonomous_shadow'` evaluates to NULL (→ row excluded)
// for the nullable column's NULL rows and would silently hide real proposals.
function orFilterKeeps(filter: string, row: Record<string, unknown>): boolean {
  return filter.split(",").some(term => {
    const [col, op, ...rest] = term.split(".");
    const value = rest.join(".");
    const cell = row[col];
    if (op === "is") return value === "null" ? cell == null : cell === value;
    if (op === "neq") return cell != null && cell !== value;
    if (op === "eq") return cell === value;
    throw new Error(`unhandled PostgREST op in filter under test: ${op}`);
  });
}

describe("EXCLUDE_SHADOW_FILTER", () => {
  it("drops shadow proposals", () => {
    expect(orFilterKeeps(EXCLUDE_SHADOW_FILTER, { execution_mode: SHADOW_EXECUTION_MODE })).toBe(false);
  });

  it("keeps ordinary proposals", () => {
    expect(orFilterKeeps(EXCLUDE_SHADOW_FILTER, { execution_mode: "manual" })).toBe(true);
  });

  // The load-bearing case. `execution_mode` is nullable (default 'manual'), and
  // a bare .neq() would exclude these rows, hiding legitimate proposals from
  // the approve queue and the desktop notification.
  it("keeps proposals whose execution_mode is NULL", () => {
    expect(orFilterKeeps(EXCLUDE_SHADOW_FILTER, { execution_mode: null })).toBe(true);
    expect(orFilterKeeps(EXCLUDE_SHADOW_FILTER, {})).toBe(true);
  });
});

describe("isShadowProposal", () => {
  it("identifies shadow rows and nothing else", () => {
    expect(isShadowProposal({ execution_mode: SHADOW_EXECUTION_MODE })).toBe(true);
    expect(isShadowProposal({ execution_mode: "manual" })).toBe(false);
    expect(isShadowProposal({ execution_mode: null })).toBe(false);
    expect(isShadowProposal(null)).toBe(false);
    expect(isShadowProposal(undefined)).toBe(false);
  });
});
