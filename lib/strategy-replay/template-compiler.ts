import type { RuleSpec, Predicate } from "./rule-spec";

/**
 * Strict compiler for the small subset of reference templates that can be
 * represented by Kairos' frozen daily-bar grammar. This intentionally refuses
 * fundamentals, sentiment, macro, volume and unsupported technical rules rather
 * than silently compiling a weaker strategy than the template describes.
 */
export interface StrategyTemplateSource {
  id: string;
  name: string;
  description?: string | null;
  rules: Record<string, unknown> | null;
}

export interface TemplateCompileOptions {
  market: "us" | "india";
  universe: string[];
  horizonSessions: number;
}

export type TemplateCompileResult =
  | { ok: true; spec: RuleSpec; compilerVersion: "template-rule-compiler-v2" }
  | { ok: false; errors: string[] };

const COMPILER_VERSION = "template-rule-compiler-v2" as const;
const SUPPORTED_KEYS = new Set([
  "rsi_min", "rsi_max", "above_ma50", "above_ma200", "ma50_above_ma200",
  "pct_from_52w_high_max", "pct_below_52w_high_min",
]);

const validSymbol = (symbol: string, market: "us" | "india") => {
  const normalized = symbol.trim().toUpperCase();
  if (market === "india") return /^[A-Z0-9&_-]+\.NS$/.test(normalized) || /^[A-Z0-9&_-]+\.BO$/.test(normalized);
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(normalized);
};

export function compileStrategyTemplate(
  template: StrategyTemplateSource,
  options: TemplateCompileOptions,
): TemplateCompileResult {
  const errors: string[] = [];
  const rules = template.rules ?? {};
  const keys = Object.keys(rules).sort();
  const unsupported = keys.filter((key) => !SUPPORTED_KEYS.has(key));
  if (unsupported.length) errors.push(`unsupported template rules: ${unsupported.join(", ")}`);
  if (keys.length === 0) errors.push("template has no executable deterministic rules");
  if (!options.universe.length || options.universe.length > 100) errors.push("universe must contain 1–100 symbols");
  if (options.universe.some((s) => !validSymbol(s, options.market))) errors.push("universe contains a symbol that does not match the selected market");
  if (new Set(options.universe.map((s) => s.trim().toUpperCase())).size !== options.universe.length) errors.push("universe symbols must be unique");
  if (!Number.isInteger(options.horizonSessions) || options.horizonSessions < 1 || options.horizonSessions > 60) errors.push("horizon_sessions must be an integer from 1 to 60");
  if (errors.length) return { ok: false, errors };

  const entryTerms: Predicate[] = [];
  for (const key of keys) {
    const value = rules[key];
    switch (key) {
      case "rsi_min":
      case "rsi_max": {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
          errors.push(`${key} must be a finite number from 0 to 100`);
          break;
        }
        entryTerms.push({ op: "cmp", left: { fn: "rsi_wilder", period: 14 }, cmp: key === "rsi_min" ? ">=" : "<=", right: value });
        break;
      }
      case "above_ma50":
      case "above_ma200":
        if (value !== true) errors.push(`${key} must be true when present`);
        else entryTerms.push({ op: "cmp2", left: { fn: "close" }, cmp: ">", right: { fn: "sma", period: key === "above_ma50" ? 50 : 200 } });
        break;
      case "ma50_above_ma200":
        if (value !== true) errors.push("ma50_above_ma200 must be true when present");
        else entryTerms.push({ op: "cmp2", left: { fn: "sma", period: 50 }, cmp: ">", right: { fn: "sma", period: 200 } });
        break;
      case "pct_from_52w_high_max":
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
          errors.push("pct_from_52w_high_max must be a finite percentage from 0 to 100");
        } else {
          // Match the template's existing classification contract: distance from
          // the trailing high is measured in percentage points and must be <= max.
          entryTerms.push({
            op: "cmp",
            left: { fn: "pct_below_rolling_high", period: 252 },
            cmp: "<=",
            right: value,
          });
        }
        break;
      case "pct_below_52w_high_min":
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
          errors.push(`${key} must be a finite percentage from 0 to 100`);
        } else {
          entryTerms.push({ op: "cmp", left: { fn: "pct_below_rolling_high", period: 252 }, cmp: ">=", right: value });
        }
        break;
    }
  }
  if (errors.length) return { ok: false, errors };

  const id = `${template.id}:${options.market}:${COMPILER_VERSION}`;
  return {
    ok: true,
    compilerVersion: COMPILER_VERSION,
    spec: {
      id,
      label: `${template.name} · deterministic shadow`,
      role: "entry",
      market: options.market,
      universe: [...new Set(options.universe.map((s) => s.trim().toUpperCase()))].sort(),
      horizonSessions: options.horizonSessions,
      execution: "next_open",
      positionSizePct: 1,
      entry: entryTerms.length === 1 ? entryTerms[0] : { op: "and", terms: entryTerms },
      exit: { op: "held_sessions", cmp: ">=", value: options.horizonSessions },
      sourceName: `Kairos strategy template ${template.id}`,
      ruleVersion: COMPILER_VERSION,
    },
  };
}
