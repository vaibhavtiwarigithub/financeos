/**
 * macro-read — pure logic for the Agent Mind "what this means for your book"
 * narrative (app/api/agent-mind/macro-read/route.ts).
 *
 * Extracted from the route because Next 15 type-checks `route.ts` exports and
 * rejects non-handler exports, so none of this could be unit-tested in place.
 * This module is NARRATIVE-ONLY: nothing here is read by any scoring, sizing,
 * gate, order or exit path. `macro_interpretations` is written by that route
 * and read back by that route's GET alone (rendered in MacroReadCard).
 *
 * It deliberately mirrors the availability discipline already merged in
 * lib/data/scores.ts (the money-path sibling). scores.ts is the authority; this
 * file reuses its exported age bound and restates the rest.
 */

import { MAX_MACRO_AGE_DAYS } from "@/lib/data/scores";

export type MarketScope = "us" | "india";

// ── India: no macro read exists, and we do not fake one ──────────────────────
//
// DECISION (2026-07-17): KILL the India macro read rather than generate an
// "honest" India narrative. Reasoning:
//
// Both macro inputs to this read are US-only, and NEITHER carries a market tag:
//
//  1. `macro_regime` — MacroSentinel's verdict, built from 8 US FRED series
//     (yield curve, Sahm rule, US GDP, nonfarm payrolls, US CPI, US retail
//     sales, fed funds, US durables). The table has NO `market` column, so
//     reading it for India stamps the US Fed's verdict onto an India book.
//
//  2. `learning_priors WHERE category='macro'` — also has NO `market` column,
//     and its contents are explicitly US macro: "Rising Fed funds rate
//     environment…" (confidence 0.80), "Dollar strengthening (DXY up)…",
//     "Yield curve inversion (2Y > 10Y)…", ISM/PMI, VIX term structure.
//
// PROD PROOF that (2) is the live leak, not just (1): macro_interpretations
// id=6 (2026-07-13, market=india) reads "…no regime-based bias can be assigned
// to this India book. The system's high-conviction belief (80%) that rising Fed
// funds rates comp[resses]…". The regime was ALREADY `unknown` in that run — so
// withholding only the regime would NOT have prevented that sentence. The
// 80% Fed-funds prior did the contaminating.
//
// Once BOTH US-only inputs are honestly withheld, an India read has ZERO macro
// evidence left — only the list of held symbols. An LLM asked to write a macro
// read with no macro input does not produce a read; it produces either a
// restatement of "we know nothing" (a CONSTANT, which does not need a
// deepseek-reasoner call every weekday) or it reaches into training knowledge
// for RBI/rupee/FII colour — inventing exactly what the prompt forbids. Neither
// is worth a daily LLM call on a free-cloud budget.
//
// So the honest India answer is a deterministic, zero-cost statement of fact,
// rendered by MacroReadCard without any LLM call or DB write.
//
// CONSISTENT WITH EXISTING PRODUCT INTENT: the India Markets view already
// renders `NotSupportedNote label="TradingView sector overview, macro sentinel
// & leveraged-pair sentiment"` — the India page ALREADY tells the user the
// macro sentinel is US-only. A weekday cron writing an India macro read derived
// from that same sentinel directly contradicts the page's own note.
//
// PARITY means both markets get an HONEST answer, not that both get an LLM
// call. "No India macro regime exists" IS the honest India answer.
//
// NOT IN SCOPE (deliberately): wiring lib/india-macro.ts (NSE FII/DII flows)
// in as a substitute regime. That is a separate approved build. Inventing an
// India regime here would be the same dishonesty in a new coat.
export const INDIA_NO_MACRO_READ_REASON =
  "No India macro read exists. Both inputs to this read are US-only and neither is market-tagged: " +
  "MacroSentinel's regime is built from 8 US FRED series (yield curve, Sahm rule, US GDP, nonfarm payrolls, " +
  "US CPI, US retail sales, fed funds, US durables), and the system's macro principles are US macro beliefs " +
  "(Fed funds, DXY, the 2Y/10Y curve, ISM/PMI, VIX). Applying either to an India book would be a US verdict " +
  "wearing an India label. No India macro regime is generated, inferred, or substituted.";

/**
 * The macro read is US-only BY CONSTRUCTION. This is the single gate: the route
 * refuses `market=india` on both GET and POST before any LLM call or DB write,
 * so even if the (still-active) kairos-macro-read-india cron fires, it burns
 * zero LLM spend and writes zero rows.
 */
export function isMacroReadSupported(market: MarketScope): boolean {
  return market === "us";
}

// ── US regime selection (mirrors lib/data/scores.ts) ─────────────────────────

export interface MacroRegimeRow {
  week_of?: unknown;
  danger_score?: number | null;
  regime?: string | null;
  summary?: string | null;
  raw_indicators?: unknown;
}

export interface ChosenMacroRegime extends MacroRegimeRow {
  ageDays: number;
  indicators: number;
}

/**
 * Minimum real indicators behind a verdict before it may inform the narrative.
 *
 * Mirrors MIN_MACRO_INDICATORS in lib/data/scores.ts, which is module-private
 * there and cannot be imported (that file is owned elsewhere and must not be
 * edited to widen its exports). Restated here with the same value and the same
 * justification: MacroSentinel's own computeRegime() refuses to classify on
 * fewer than 3 of its 8 FRED indicators, because "<3 indicators is NOT evidence
 * of a healthy economy". Prod contains fossil rows that prove the point — the
 * 2026-06-30 `green`/danger-0 row has `raw_indicators = []` (a failed run
 * fossilized as a calm verdict) and the 2026-06-29 `red`/danger-100 row rests
 * on 1 indicator.
 *
 * KEEP IN SYNC with lib/data/scores.ts. If these ever diverge, the narrative
 * would describe a macro backdrop the money path refuses to score — the exact
 * inconsistency this whole fix exists to remove.
 */
export const MIN_MACRO_INDICATORS = 3;

export { MAX_MACRO_AGE_DAYS };

function macroRowAgeDays(weekOf: unknown, now: Date): number {
  if (typeof weekOf !== "string") return Infinity; // unverifiable age → fail closed
  const t = Date.parse(`${weekOf}T00:00:00Z`);
  if (!Number.isFinite(t)) return Infinity;
  return (now.getTime() - t) / 86_400_000;
}

function macroIndicatorCount(rawIndicators: unknown): number {
  return Array.isArray(rawIndicators) ? rawIndicators.length : -1;
}

export interface MacroRegimeSelection {
  chosen: ChosenMacroRegime | null;
  rejected: { week_of: unknown; regime: unknown; reason: string }[];
}

/**
 * Pick the newest macro_regime row that may inform the read, or none.
 *
 * A row qualifies only if ALL hold (same three tests as lib/data/scores.ts):
 *   1. MacroSentinel reached a verdict (regime != "unknown") — an unknown row's
 *      danger_score is a placeholder 0, NOT a calm read.
 *   2. It is within MAX_MACRO_AGE_DAYS — no unbounded reach-back.
 *   3. It rests on >= MIN_MACRO_INDICATORS real indicators — rejects fossils.
 *
 * FAIL-SAFE: nothing qualifies → `chosen: null` → the prompt says the regime is
 * UNAVAILABLE. It never falls back to calm/green and never reaches further back.
 */
export function selectMacroRegime(rows: MacroRegimeRow[] | null | undefined, now: Date): MacroRegimeSelection {
  const all = Array.isArray(rows) ? rows : rows ? [rows] : [];
  const rejected: MacroRegimeSelection["rejected"] = [];
  for (const r of all) {
    if (!r) continue;
    const regime = String(r.regime ?? "").toLowerCase();
    const ageDays = macroRowAgeDays(r.week_of, now);
    const indicators = macroIndicatorCount(r.raw_indicators);
    let reason: string | null = null;
    if (regime === "unknown" || regime === "") reason = "no verdict (regime unknown)";
    else if (ageDays > MAX_MACRO_AGE_DAYS) reason = `stale: ${Math.floor(ageDays)}d old > ${MAX_MACRO_AGE_DAYS}d bound`;
    else if (indicators < MIN_MACRO_INDICATORS) {
      reason = `only ${indicators < 0 ? "unverifiable" : indicators} indicator(s) < ${MIN_MACRO_INDICATORS} — failed run, not a real verdict`;
    }
    if (reason) {
      rejected.push({ week_of: r.week_of, regime: r.regime, reason });
      continue;
    }
    return { chosen: { ...r, ageDays, indicators }, rejected };
  }
  return { chosen: null, rejected };
}

// ── Prompt ───────────────────────────────────────────────────────────────────

/**
 * Build the US macro read prompt.
 *
 * The `market: "us"` literal is not decoration — it makes "an India read
 * containing a US regime verdict" UNREPRESENTABLE at the type level. There is
 * no code path that builds an India prompt, so there is nothing to leak into.
 *
 * When `chosen` is null the prompt states the regime is UNAVAILABLE and gives
 * the model NO regime, NO danger score, NO summary and NO raw indicators to
 * work from — a rejected row's fields are never interpolated. An absent verdict
 * is described as absent, never as calm.
 */
export function buildMacroReadPrompt(opts: {
  market: "us";
  chosen: ChosenMacroRegime | null;
  book: string;
  priorsText: string;
}): string {
  const { chosen, book, priorsText } = opts;

  const regimeBlock = chosen
    ? `MACRO REGIME: ${chosen.regime} (danger score ${chosen.danger_score}/100)
REGIME AS OF: week of ${chosen.week_of} (${Math.floor(chosen.ageDays)} day(s) old, ${chosen.indicators} real indicators)
REGIME SUMMARY: ${chosen.summary ?? "n/a"}
RAW INDICATORS: ${JSON.stringify(chosen.raw_indicators ?? {}).slice(0, 1500)}`
    : `MACRO REGIME: UNAVAILABLE — no trustworthy verdict within the last ${MAX_MACRO_AGE_DAYS} days.
Every recent MacroSentinel row was either unclassified, older than the ${MAX_MACRO_AGE_DAYS}-day bound, or rested on fewer than ${MIN_MACRO_INDICATORS} real indicators. There is NO regime, NO danger score and NO indicator data for you to use. An absent macro verdict is NOT a calm one: say plainly that the macro backdrop is unknown right now, assign NO regime-based bias in either direction, and do not guess what the regime probably is.`;

  return `You are a macro strategist. Using ONLY the data below (do not invent any numbers), write a short (4-6 sentence) plain-English read of what the current macro backdrop means for THIS book. Tie the regime and the raw indicators to specific holdings where relevant, and reference the macro principles by their stated confidence. Advisory only.

MARKET: US (this book and every input below are US. The macro regime and the macro principles are US-only by construction.)
${regimeBlock}
CURRENT BOOK: ${book}
MACRO PRINCIPLES (the system's beliefs, with confidence):
${priorsText || "none"}

Write the read now. Do not give trade instructions or invent figures not shown above.`;
}
