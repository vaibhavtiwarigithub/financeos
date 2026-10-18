import { createHash } from "node:crypto";
import { assessMacroIndicators, type MacroSignal } from "@/lib/data/macro-regime-integrity";

export type LegacyUsRegime = "green" | "yellow" | "orange" | "red" | "unknown";

export function buildUsMacroRegimeRun(input: {
  weekOf: string;
  regime: LegacyUsRegime;
  dangerScore: number | null;
  rawIndicators: unknown;
  computedAt: string;
}) {
  const integrity = assessMacroIndicators(input.rawIndicators);
  const domesticState = !integrity.usable ? "unavailable"
    : input.regime === "green" ? "supportive"
    : input.regime === "yellow" ? "neutral"
    : input.regime === "orange" || input.regime === "red" ? "adverse"
    : "unavailable";
  const indicators = integrity.validIndicators.map((row) => ({
    name: row.name,
    value: row.value,
    signal: row.signal as MacroSignal,
    weight: row.weight,
  })).sort((a, b) => a.name.localeCompare(b.name));
  const fingerprintInput = {
    market: "us",
    weekOf: input.weekOf,
    formulaVersion: "macro-sentinel-state-v1",
    regime: input.regime,
    dangerScore: input.dangerScore,
    indicators,
  };
  const inputFingerprint = createHash("sha256").update(JSON.stringify(fingerprintInput)).digest("hex");

  return {
    market: "us" as const,
    domestic_state: domesticState,
    // MacroSentinel does not produce a separately validated global-spillover state.
    global_spillover_state: "unavailable" as const,
    formula_version: "macro-sentinel-state-v1",
    input_fingerprint: inputFingerprint,
    computed_at: input.computedAt,
    eligible_input_count: integrity.indicatorsAvailable,
  };
}
