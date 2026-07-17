import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeInsiderScore } from "@/lib/data/scores";
import type { InsiderTrade } from "@/lib/nse-data";

// ─────────────────────────────────────────────────────────────────────────────
// India insider (SEBI PIT) is DELIBERATELY NOT WIRED into insider_score.
//
// This file pins that decision so a future change cannot casually wire it back
// in without confronting the evidence. `insider_score` is one of the 5 genome
// dimensions — a fake reading here reaches paper buys.
//
// Live evidence gathered 2026-07-17 against NSE /api/corporates-pit, measured
// over the 34 real India symbols in the live book (agent_signals market='india'):
//
//   * 90d coverage (the US insider_score window):  2/34 symbols = 6%
//   * >=3 open-market txns in 90d (the US bar,
//     research-agent MIN_INSIDER_TRANSACTIONS=3): 0/34 symbols = 0%
//   * Even widening to 365d:                      1/10 large caps scorable
//   * Semantics: only ~30% of PIT rows are open-market (Market Purchase 9.7% +
//     Market Sale 19.5%). The rest are ESOP allotments (29.2%), Off Market
//     (22.1%), Gift (5.3%), pledges, amalgamations — NOT the US Form 4
//     open-market buy/sell-value signal that insider_score means.
//
// A dimension available for 0% of the universe is not a usable dimension, and a
// same-named field carrying different meaning across markets is worse than an
// absent one. India's insider dimension stays HONESTLY UNAVAILABLE: the
// availability mask excludes it and renormalizes weights onto the rest.
// ─────────────────────────────────────────────────────────────────────────────

const RESEARCH_AGENT = resolve(__dirname, "../lib/research-agent.ts");

// Strip comments before matching — the decision is documented by name in the
// source comments, so a raw text scan would match the explanation of the
// decision and fail on the very code that encodes it.
const source = () =>
  readFileSync(RESEARCH_AGENT, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("India insider — structurally excluded from scoring", () => {
  it("does not feed NSE PIT disclosures into the insider resolver", () => {
    // The US cascade is Massive -> EDGAR -> Alpha Vantage. No India leg.
    expect(source()).not.toContain("fetchNseInsider");
    expect(source()).not.toContain("nse-data");
  });

  it("keeps the US insider cascade intact and unchanged", () => {
    const src = source();
    expect(src).toContain("scoreMassiveInsider");
    expect(src).toContain("scoreEdgarInsider");
    // Each source only wins on available:true, so a dead source cascades.
    expect(src).toMatch(/massive\?\.available/);
    expect(src).toMatch(/edgar\?\.available/);
  });

  it("excludes 'insider' from the applicable dimensions of an India symbol", () => {
    // Pinned statically: importing research-agent.ts pulls the full provider
    // graph. The India branch of applicableDimensions() must return BEFORE the
    // US block that adds the insider dimension.
    const src = source();
    const indiaBranch = src.slice(src.indexOf("const india = isIndia"), src.indexOf("if (entry.isEtf)"));
    expect(indiaBranch).not.toContain('dims.add("insider")');
    // ...and it must actually return early rather than fall through.
    expect(indiaBranch).toMatch(/return dims;/);
  });
});

describe("normalizeInsiderScore — fails closed on the raw NSE PIT shape", () => {
  // The failure mode this guards: someone passes fetchNseInsider() output
  // straight into computeScores({ insiderResult }). The NSE shape carries no
  // `available` field, so it MUST NOT be read as real balanced insider activity
  // and included at a neutral 50.
  it("treats an NSE InsiderTrade[] as unavailable, not a neutral-50 inclusion", () => {
    const nseTrades: InsiderTrade[] = [
      { symbol: "BAJAJFINSV", person: "Bajaj Holdings & Investment Limited", type: "BUY", qty: 1000, value: 2_000_000, date: "02-May-2026" },
    ];
    const r = normalizeInsiderScore(nseTrades);
    expect(r.available).toBe(false);
  });

  it("treats a throttled/blocked NSE fetch (empty array) as unavailable", () => {
    // fetchNseInsider fails SOFT: an NSE geo-throttle/block returns []. That is
    // indistinguishable from "no disclosures" and must never score.
    expect(normalizeInsiderScore([]).available).toBe(false);
    expect(normalizeInsiderScore(null).available).toBe(false);
  });

  it("never reports available:true without an explicit available field", () => {
    // Fail CLOSED: an unrecognized shape is a data-quality problem, not
    // evidence of genuinely balanced insider activity.
    expect(normalizeInsiderScore({ score: 50 }).available).toBe(false);
    expect(normalizeInsiderScore({ score: 90, summary: "looks bullish" }).available).toBe(false);
  });

  it("still honors an explicit honest available:true from the US scorers", () => {
    const r = normalizeInsiderScore({ score: 82, summary: "4 buys vs 1 sell", available: true });
    expect(r.available).toBe(true);
    expect(r.score).toBe(82);
  });
});
