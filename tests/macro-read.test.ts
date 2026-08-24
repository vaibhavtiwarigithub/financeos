import { describe, it, expect } from "vitest";
import {
  INDIA_NO_MACRO_READ_REASON,
  MAX_MACRO_AGE_DAYS,
  MIN_MACRO_INDICATORS,
  buildMacroReadPrompt,
  isMacroReadSupported,
  selectMacroRegime,
} from "@/lib/macro-read";
import { MACRO_INDICATOR_WEIGHTS } from "@/lib/data/macro-regime-integrity";

// NARRATIVE-PATH TESTS for the Agent Mind macro read
// (app/api/agent-mind/macro-read/route.ts). This read does NOT feed scoring,
// sizing, gates or orders — but it is shown to the owner as the system's
// explanation of its own macro stance, so a US verdict wearing an India label
// is a lie to the operator even when no money moves on it.
//
// Three proven prod bugs are pinned here:
//
//  BUG 1 — the route read `macro_regime` with NO market filter and stamped
//          `MARKET: ${market.toUpperCase()}` into the prompt. macro_regime has
//          no `market` column and is built from 8 US FRED series.
//  BUG 2 — `learning_priors WHERE category='macro'` is ALSO unmarket-tagged and
//          explicitly US (Fed funds, DXY, 2Y/10Y, ISM/PMI, VIX). This is the
//          input that actually produced the contaminated prod row, id=6.
//  BUG 3 — the regime selector took the single newest row with no unknown /
//          age / indicator guards, so a fossil could present as a live verdict.

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** The exact prod macro_regime table as of 2026-07-17 (verified via MCP). */
const REAL_INDICATORS = Object.entries(MACRO_INDICATOR_WEIGHTS).map(([name, weight]) => ({
  name, weight, value: 1, signal: "yellow", description: name,
}));
const ORANGE_40 = REAL_INDICATORS.slice(0, 7).map((row, index) => ({
  ...row,
  signal: index < 2 ? "orange" : index === 6 ? "green" : "yellow",
}));
const PROD_ROWS = [
  { week_of: "2026-07-13", regime: "orange", danger_score: 40, summary: "Mixed signals.", raw_indicators: ORANGE_40 },
  { week_of: "2026-07-06", regime: "unknown", danger_score: 0, summary: "Insufficient data.", raw_indicators: [] },
  { week_of: "2026-06-30", regime: "green", danger_score: 0, summary: "No recession signals. Economy in expansion.", raw_indicators: [] },
];

/** The real prod macro priors (learning_priors, category='macro', enabled). */
const PROD_PRIORS_TEXT = [
  "- Rising Fed funds rate environment reduces valuation multiples for high-PE growth stocks [confidence 80%]",
  "- Dollar strengthening (DXY up) headwind for US multinationals and emerging market exposure [confidence 72%]",
  "- Yield curve inversion (2Y > 10Y) precedes recessions by 6-18 months — reduce equity risk [confidence 70%]",
].join("\n");

/** The real 13-position India book that prod row id=6 was written against. */
const INDIA_BOOK = "ICICIBANK.NS (Financial Services), RELIANCE.NS (Energy), TCS.NS (Technology)";

// ── BUG 1 + BUG 2: India must never receive a US macro read ──────────────────

describe("India macro read — killed, not faked", () => {
  it("is structurally unsupported for india and supported for us", () => {
    // FAILS PRE-FIX: no such gate existed — `market=india` ran the full LLM path.
    expect(isMacroReadSupported("india")).toBe(false);
    expect(isMacroReadSupported("us")).toBe(true);
  });

  it("states why no India read exists without inventing an India regime", () => {
    const reason = INDIA_NO_MACRO_READ_REASON.toLowerCase();
    // Names the real cause...
    expect(reason).toContain("us-only");
    expect(reason).toContain("fred");
    // ...and does NOT reach for an India regime substitute. lib/india-macro.ts
    // (FII/DII) is a separate approved build, not a stand-in regime.
    expect(reason).not.toMatch(/\brbi\b/);
    expect(reason).not.toMatch(/\brupee\b/);
    // Never asserts a regime VERDICT for India. (Saying an India regime is not
    // generated/substituted is the honest statement — that is the whole point.)
    expect(reason).not.toMatch(/india('s)? macro regime (is|shows|suggests|looks) (calm|green|red|orange|risk)/);
    expect(reason).toMatch(/not (generated|market-tagged)|no india macro/);
  });

  it("makes an India prompt UNREPRESENTABLE — no code path can build one", () => {
    // The type system is the guarantee: buildMacroReadPrompt only accepts
    // market: "us". This asserts the runtime shape agrees.
    // @ts-expect-error — "india" is not assignable; this is the point.
    const attempt = () => buildMacroReadPrompt({ market: "india", chosen: null, book: INDIA_BOOK, priorsText: PROD_PRIORS_TEXT });
    // Even if a caller forced it through at runtime, the prompt is hard-coded to
    // US and could never claim to be an India read.
    expect(attempt()).toContain("MARKET: US");
    expect(attempt()).not.toContain("MARKET: INDIA");
  });

  it("REGRESSION (prod row id=6): no India surface carries the 80% Fed-funds prior", () => {
    // Prod row id=6 (2026-07-13, market=india) reads: "…no regime-based bias can
    // be assigned to this India book. The system's high-conviction belief (80%)
    // that rising Fed funds rates comp…" — with the regime ALREADY `unknown`.
    // So the Fed-funds leak came from learning_priors, NOT from macro_regime:
    // withholding only the regime would NOT have prevented that sentence.
    //
    // FAILS PRE-FIX: the pre-fix route interpolated PROD_PRIORS_TEXT into an
    // India prompt verbatim. Post-fix there is no India prompt at all, so the
    // only India-facing string is the refusal — which must be prior-free.
    const indiaSurface = INDIA_NO_MACRO_READ_REASON;
    expect(indiaSurface).not.toContain("confidence 80%");
    expect(indiaSurface).not.toMatch(/high-conviction/i);
    // It may NAME Fed funds to explain the US-ness of the inputs, but must never
    // assert a Fed-funds BELIEF about the India book.
    expect(indiaSurface).not.toMatch(/rising fed funds rates? (compress|reduce)/i);
  });
});

// ── BUG 3: a fossil/stale regime must not present as a live verdict ──────────

describe("US regime selection — absent is not calm", () => {
  const NOW = new Date("2026-07-17T09:00:00Z");

  it("picks the real 7-indicator orange verdict from the prod table", () => {
    const { chosen } = selectMacroRegime(PROD_ROWS, NOW);
    expect(chosen?.regime).toBe("orange");
    expect(chosen?.indicators).toBe(7);
  });

  it("REGRESSION: never reaches back to the 2026-06-30 green fossil", () => {
    // The fossil: danger_score 0, regime "green", raw_indicators [] — a FAILED
    // run fossilized as a calm verdict. On 2026-07-13 the money-path selector
    // reached back to it (13 days) and scored 13 India rows maximally calm.
    // Here: only unknown/fossil rows are available, so macro must be ABSENT.
    const onlyFossils = PROD_ROWS.filter((r) => r.regime !== "orange");
    const { chosen, rejected } = selectMacroRegime(onlyFossils, NOW);
    // FAILS PRE-FIX: the old code took the newest row unconditionally.
    expect(chosen).toBeNull();
    // The 07-06 row has no verdict; the 06-30 green fossil is caught by the age
    // bound first (17d from NOW) — it is independently caught by the indicator
    // floor too, asserted separately below.
    expect(rejected.map((r) => r.reason)).toEqual([
      "no verdict (regime unknown)",
      `stale: 17d old > ${MAX_MACRO_AGE_DAYS}d bound`,
    ]);
  });

  it("rejects a FRESH zero-indicator green fossil on the indicator floor alone", () => {
    // The age bound cannot catch a fossil written THIS week — only the
    // indicator floor can. Same shape as the 2026-06-30 prod row, dated today:
    // "green", danger_score 0, raw_indicators []. Must NOT read as calm.
    const freshFossil = [{ week_of: "2026-07-13", regime: "green", danger_score: 0, summary: "No recession signals. Economy in expansion.", raw_indicators: [] }];
    const { chosen, rejected } = selectMacroRegime(freshFossil, NOW);
    expect(chosen).toBeNull();
    expect(rejected[0].reason).toContain(`requires >=${MIN_MACRO_INDICATORS} indicators`);
  });

  it("rejects the 1-indicator red fossil (prod row id=1) too — floor is not directional", () => {
    // The floor rejects on EVIDENCE COUNT, not on direction: a bearish fossil is
    // as untrustworthy as a calm one. Prod id=1: red, danger 100, 1 indicator.
    const redFossil = [{ week_of: "2026-07-13", regime: "red", danger_score: 100, summary: "Recession imminent.", raw_indicators: [{ ...REAL_INDICATORS[0], signal: "red" }] }];
    const { chosen, rejected } = selectMacroRegime(redFossil, NOW);
    expect(chosen).toBeNull();
    expect(rejected[0].reason).toContain("coverage 1/8");
  });

  it("rejects a verdict older than the age bound even when well-evidenced", () => {
    const stale = [{ week_of: "2026-06-01", regime: "green", danger_score: 5, summary: "Calm.", raw_indicators: REAL_INDICATORS }];
    const { chosen, rejected } = selectMacroRegime(stale, NOW);
    expect(chosen).toBeNull();
    expect(rejected[0].reason).toContain(`> ${MAX_MACRO_AGE_DAYS}d bound`);
  });

  it("fails closed on an unverifiable week_of", () => {
    const bad = [{ week_of: null, regime: "green", danger_score: 0, summary: "x", raw_indicators: new Array(8).fill({}) }];
    expect(selectMacroRegime(bad, NOW).chosen).toBeNull();
  });

  it("fails closed when raw_indicators is not an array", () => {
    const bad = [{ week_of: "2026-07-13", regime: "green", danger_score: 0, summary: "x", raw_indicators: null }];
    const { chosen, rejected } = selectMacroRegime(bad, NOW);
    expect(chosen).toBeNull();
    expect(rejected[0].reason).toContain("unverifiable");
  });

  it("handles an empty table as absent, not calm", () => {
    expect(selectMacroRegime([], NOW).chosen).toBeNull();
    expect(selectMacroRegime(null, NOW).chosen).toBeNull();
  });
});

// ── Prompt honesty ───────────────────────────────────────────────────────────

describe("US prompt", () => {
  const NOW = new Date("2026-07-17T09:00:00Z");
  const US_BOOK = "AAPL (Technology), XOM (Energy)";

  it("carries the real verdict when one qualifies (US behavior unchanged)", () => {
    const { chosen } = selectMacroRegime(PROD_ROWS, NOW);
    const p = buildMacroReadPrompt({ market: "us", chosen, book: US_BOOK, priorsText: PROD_PRIORS_TEXT });
    expect(p).toContain("MARKET: US");
    expect(p).toContain("MACRO REGIME: orange (danger score 40/100)");
    expect(p).toContain("AAPL (Technology)");
    // US priors on a US book is correct and must survive the fix.
    expect(p).toContain("confidence 80%");
    expect(p).toContain("Do not give trade instructions or invent figures not shown above.");
  });

  it("describes an absent verdict as UNKNOWN and never as calm", () => {
    const p = buildMacroReadPrompt({ market: "us", chosen: null, book: US_BOOK, priorsText: PROD_PRIORS_TEXT });
    expect(p).toContain("MACRO REGIME: UNAVAILABLE");
    expect(p).toMatch(/absent macro verdict is NOT a calm one/i);
    expect(p).toMatch(/assign NO regime-based bias/i);
    // FAILS PRE-FIX: the old prompt interpolated the rejected row's fields,
    // so a fossil's "green"/"danger score 0" reached the model verbatim.
    expect(p).not.toContain("danger score 0/100");
    expect(p).not.toContain("No recession signals. Economy in expansion.");
  });

  it("leaks no rejected row's summary or indicators into the prompt", () => {
    const onlyFossils = PROD_ROWS.filter((r) => r.regime !== "orange");
    const { chosen } = selectMacroRegime(onlyFossils, NOW);
    const p = buildMacroReadPrompt({ market: "us", chosen, book: US_BOOK, priorsText: PROD_PRIORS_TEXT });
    for (const row of onlyFossils) expect(p).not.toContain(row.summary);
    expect(p).not.toContain("RAW INDICATORS:");
  });
});
