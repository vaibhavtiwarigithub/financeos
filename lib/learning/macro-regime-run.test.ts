import { describe, expect, it } from "vitest";
import { MACRO_INDICATOR_WEIGHTS } from "@/lib/data/macro-regime-integrity";
import { buildUsMacroRegimeRun } from "@/lib/learning/macro-regime-run";

const indicators = Object.entries(MACRO_INDICATOR_WEIGHTS).map(([name, weight]) => ({
  name, value: 1, signal: "green", description: "test", weight,
}));

describe("US macro regime run ledger projection", () => {
  it("maps the legacy US state conservatively and never invents a global state", () => {
    const adverse = buildUsMacroRegimeRun({ weekOf: "2026-10-12", regime: "red", dangerScore: 65, rawIndicators: indicators, computedAt: "2026-10-12T12:00:00.000Z" });
    expect(adverse.domestic_state).toBe("adverse");
    expect(adverse.global_spillover_state).toBe("unavailable");
    expect(adverse.market).toBe("us");
    expect(adverse.eligible_input_count).toBe(8);
    expect(adverse.input_fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("records incomplete or unknown states as unavailable, not supportive", () => {
    const unavailable = buildUsMacroRegimeRun({ weekOf: "2026-10-12", regime: "unknown", dangerScore: null, rawIndicators: [], computedAt: "2026-10-12T12:00:00.000Z" });
    expect(unavailable.domestic_state).toBe("unavailable");
    expect(unavailable.eligible_input_count).toBe(0);
    const mislabeled = buildUsMacroRegimeRun({ weekOf: "2026-10-12", regime: "green", dangerScore: 0, rawIndicators: [], computedAt: "2026-10-12T12:00:00.000Z" });
    expect(mislabeled.domestic_state).toBe("unavailable");
  });

  it("fingerprints equivalent inputs deterministically and changes when evidence changes", () => {
    const base = { weekOf: "2026-10-12", regime: "yellow" as const, dangerScore: 25, rawIndicators: indicators, computedAt: "2026-10-12T12:00:00.000Z" };
    const first = buildUsMacroRegimeRun(base);
    const reordered = buildUsMacroRegimeRun({ ...base, rawIndicators: [...indicators].reverse() });
    const changed = buildUsMacroRegimeRun({ ...base, dangerScore: 26 });
    expect(first.input_fingerprint).toBe(reordered.input_fingerprint);
    expect(first.input_fingerprint).not.toBe(changed.input_fingerprint);
  });
});
