// Risk Analytics research annotation — T1..T8 from
// features/risk-research-visibility/FEATURE_ARCHITECTURE.md §7.
//
// Every test here must be able to FAIL. A test that cannot fail is worse than no
// test: it buys confidence without paying for it. Where a test pins an invariant
// (T1, T3) it is accompanied by a synthetic counter-example proving the check
// actually fires — otherwise "risk is research-free" would be an assertion about
// nothing.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildResearchBlock,
  indexLatestSignals,
  researchKey,
  researchStateSentence,
  isResearchLinkable,
  STALE_AFTER_SESSIONS,
  type ResearchSignalRow,
} from "@/lib/research/risk-annotation";

const REPO = join(__dirname, "..");

function sig(over: Partial<ResearchSignalRow> = {}): ResearchSignalRow {
  return {
    symbol: "AVGO", market: "us",
    analyst_score: 80, direction: "neutral",
    created_at: "2026-07-13T14:18:45Z", is_holding: false,
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// T1 — R1: research does not enter the risk computation.
//
// Two halves, because they fail for different reasons:
//   (a) architectural — the risk modules must not READ research at all;
//   (b) behavioral   — attaching the block must not perturb any risk field.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip comments before looking for coupling.
 *
 * This is not incidental: `lib/risk/sector-breach.ts` contains the line
 * "It reads no research score, no analyst_score, no conviction ordering" — prose
 * ASSERTING the invariant. A naive grep flags that as a violation and the guard
 * becomes noise everyone disables. We check CODE, not commentary.
 */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")  // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // line comments (not the // in a URL)
}

/** Does this source READ research? True = R1 violated. */
export function hasResearchCoupling(src: string): boolean {
  const code = stripComments(src);
  return /\banalyst_score\b|\bconviction\b|\bagent_signals\b|\bresearch(Block|_score|Score)\b|risk-annotation/.test(code);
}

describe("T1a — R1 architectural: the risk engine reads no research", () => {
  // The modules the invariant names. If research is wired into a risk decision,
  // it has to appear in one of these.
  const RISK_MODULES = [
    "lib/risk/holding-risk.ts",
    "lib/risk/sector-breach.ts",
    "lib/risk/live-portfolio-gate.ts",
    "lib/risk/sizing.ts",
    "lib/risk/correlation.ts",
    "lib/risk/percentiles.ts",
  ];

  for (const rel of RISK_MODULES) {
    it(`${rel} does not read research`, () => {
      const src = readFileSync(join(REPO, rel), "utf-8");
      expect(hasResearchCoupling(src)).toBe(false);
    });
  }

  // ── The falsification: prove the detector can actually fire. ───────────────
  // Without this, T1a passes trivially forever — including on the day someone
  // wires the score in and the regex has quietly stopped matching.
  it("DETECTOR FIRES: a risk module that reads analyst_score is caught", () => {
    const wired = `
      import { computeStuff } from "./x";
      export function computeHoldingRisk(h: any, sig: any) {
        // conviction ordering is fine in a comment
        if (sig.analyst_score > 80) return { posture: "hold" };
        return computeStuff(h);
      }`;
    expect(hasResearchCoupling(wired)).toBe(true);
  });

  it("DETECTOR IGNORES PROSE: a comment asserting the invariant is not a violation", () => {
    const proseOnly = `
      // It reads no research score, no analyst_score, no conviction ordering.
      /* analyst_score must never appear below this line */
      export function computeHoldingRisk(h: any) { return { posture: "hold" }; }`;
    expect(hasResearchCoupling(proseOnly)).toBe(false);
  });

  it("the real sector-breach.ts mentions analyst_score in PROSE — the case that motivated stripping comments", () => {
    const src = readFileSync(join(REPO, "lib/risk/sector-breach.ts"), "utf-8");
    expect(src).toMatch(/analyst_score/);          // present as text …
    expect(hasResearchCoupling(src)).toBe(false);  // … but not as code.
  });
});

describe("T1b — R1 behavioral: attaching research leaves risk output byte-identical", () => {
  // Mirrors what the route does: risk fields are replayed from the snapshot and
  // the block is attached alongside. This fails the moment attach() reaches into
  // a risk field.
  const snapshot = {
    symbol: "AVGO", sector: "Technology", holding_risk_score: 63,
    risk_posture: "trim", action_reason: "Technology is over its 30% cap",
    weight_pct: 0.12, beta: 1.4, data_confidence: 0.9,
  };

  const attach = (row: typeof snapshot, s: ResearchSignalRow | undefined) => ({
    ...row,
    research: buildResearchBlock(s, new Date("2026-07-17T13:00:00Z"), "us"),
  });

  const riskFieldsOf = (o: Record<string, unknown>) => {
    const { research: _drop, ...rest } = o as any;
    return JSON.stringify(rest);
  };

  it("risk fields are identical with the research block present vs absent", () => {
    const withResearch = attach(snapshot, sig());
    expect(riskFieldsOf(withResearch)).toBe(JSON.stringify(snapshot));
  });

  it("risk fields do not vary with the research score, direction, or staleness", () => {
    const variants = [
      sig({ analyst_score: 5, direction: "short" }),
      sig({ analyst_score: 99, direction: "long" }),
      sig({ created_at: "2020-01-01T00:00:00Z" }), // maximally stale
      undefined,                                    // never scored
    ];
    const outputs = variants.map(v => riskFieldsOf(attach(snapshot, v)));
    // Every variant must yield the same risk bytes.
    expect(new Set(outputs).size).toBe(1);
    expect(outputs[0]).toBe(JSON.stringify(snapshot));
  });

  it("attaching does not mutate the source snapshot", () => {
    const before = JSON.stringify(snapshot);
    attach(snapshot, sig({ analyst_score: 99 }));
    expect(JSON.stringify(snapshot)).toBe(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T2 — stale vs fresh, and the day count that goes with it.
// ─────────────────────────────────────────────────────────────────────────────
describe("T2 — a score older than the threshold is stale, one inside is fresh", () => {
  it("AVGO's real prod row (scored Mon 2026-07-13, read Fri 2026-07-17) is STALE", () => {
    // The actual failure this feature exists for. 4 sessions > 2.
    const b = buildResearchBlock(sig(), new Date("2026-07-17T13:00:00Z"), "us");
    expect(b.state).toBe("stale");
    expect(b.sessions_since).toBe(4);
    expect(b.days_since).toBe(4);
    expect(b.score).toBe(80);
    expect(researchStateSentence(b)).toContain("Not scored in 4 days");
  });

  it("a score inside the threshold is fresh", () => {
    const b = buildResearchBlock(
      sig({ created_at: "2026-07-16T13:00:00Z" }), // Thu → Fri = 1 session
      new Date("2026-07-17T13:00:00Z"), "us",
    );
    expect(b.state).toBe("fresh");
    expect(b.sessions_since).toBe(1);
  });

  it("the threshold boundary is inclusive: exactly STALE_AFTER_SESSIONS is still fresh", () => {
    // Wed → Fri = 2 sessions, threshold 2.
    const b = buildResearchBlock(
      sig({ created_at: "2026-07-15T13:00:00Z" }),
      new Date("2026-07-17T13:00:00Z"), "us",
    );
    expect(b.sessions_since).toBe(STALE_AFTER_SESSIONS);
    expect(b.state).toBe("fresh");
  });

  it("one session past the threshold flips to stale", () => {
    const b = buildResearchBlock(
      sig({ created_at: "2026-07-14T13:00:00Z" }), // Tue → Fri = 3 sessions
      new Date("2026-07-17T13:00:00Z"), "us",
    );
    expect(b.sessions_since).toBe(3);
    expect(b.state).toBe("stale");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T3 — THE ONE THAT KILLS A CALENDAR-DAY IMPLEMENTATION.
// ─────────────────────────────────────────────────────────────────────────────
describe("T3 — staleness is counted in market-local SESSIONS, not calendar days", () => {
  it("Friday score read Monday, threshold 1 session → FRESH (3 calendar days, 1 session)", () => {
    // 2026-07-10 is a Friday; 2026-07-13 is the following Monday.
    const b = buildResearchBlock(
      sig({ created_at: "2026-07-10T14:00:00Z" }),
      new Date("2026-07-13T14:00:00Z"),
      "us",
      1, // threshold = 1 session
    );
    expect(b.sessions_since).toBe(1);  // a day-count implementation says 3 …
    expect(b.state).toBe("fresh");     // … and therefore wrongly says "stale" here.
    expect(b.days_since).toBe(3);      // days are still DISPLAYED honestly.
  });

  it("days_since and sessions_since genuinely disagree across a weekend — so one cannot stand in for the other", () => {
    const b = buildResearchBlock(
      sig({ created_at: "2026-07-10T14:00:00Z" }),
      new Date("2026-07-13T14:00:00Z"), "us",
    );
    expect(b.days_since).toBe(3);
    expect(b.sessions_since).toBe(1);
    expect(b.days_since).not.toBe(b.sessions_since);
  });

  it("a US market holiday does not count as a session (2026-07-03 is observed Independence Day)", () => {
    // Wed 2026-07-01 → Mon 2026-07-06. Calendar: 5 days. Weekdays: Thu 2, Fri 3
    // (HOLIDAY), Mon 6 → sessions = Thu + Mon = 2, not 3.
    const b = buildResearchBlock(
      sig({ created_at: "2026-07-01T14:00:00Z" }),
      new Date("2026-07-06T14:00:00Z"), "us",
    );
    expect(b.days_since).toBe(5);
    expect(b.sessions_since).toBe(2);
  });

  it("India and US disagree on their own holidays — the calendar is market-local, not shared", () => {
    // 2026-08-15 (Sat) is an India holiday; use 2026-10-02 (Fri, Gandhi Jayanti),
    // an India holiday that is an ORDINARY trading day in the US.
    const at = "2026-10-01T06:00:00Z";  // Thu
    const now = new Date("2026-10-05T06:00:00Z"); // Mon
    const india = buildResearchBlock(sig({ created_at: at, market: "india" }), now, "india");
    const us = buildResearchBlock(sig({ created_at: at }), now, "us");
    // Same instants, same calendar span, different session counts.
    expect(india.days_since).toBe(us.days_since);
    expect(india.sessions_since).toBe(1); // Fri is a holiday → only Mon counts
    expect(us.sessions_since).toBe(2);    // Fri + Mon
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T4 — `never` is its own state, and is not a link.
// ─────────────────────────────────────────────────────────────────────────────
describe("T4 — no signal → never (not stale, not 0, not a link)", () => {
  const b = buildResearchBlock(undefined, new Date("2026-07-17T13:00:00Z"), "us");

  it("state is 'never', not 'stale'", () => {
    expect(b.state).toBe("never");
    expect(b.state).not.toBe("stale");
  });

  it("the score is null — never 0, which would render as a real (terrible) score", () => {
    expect(b.score).toBeNull();
    expect(b.score).not.toBe(0);
  });

  it("carries no age: there is nothing to be old", () => {
    expect(b.scored_at).toBeNull();
    expect(b.sessions_since).toBeNull();
    expect(b.days_since).toBeNull();
  });

  it("is NOT linkable — a link to nothing is a lie", () => {
    expect(isResearchLinkable(b)).toBe(false);
  });

  it("every other state IS linkable", () => {
    const now = new Date("2026-07-17T13:00:00Z");
    expect(isResearchLinkable(buildResearchBlock(sig(), now, "us"))).toBe(true);                       // stale
    expect(isResearchLinkable(buildResearchBlock(sig({ created_at: "2026-07-16T13:00:00Z" }), now, "us"))).toBe(true); // fresh
    expect(isResearchLinkable(buildResearchBlock(sig({ analyst_score: null }), now, "us"))).toBe(true); // unavailable
  });

  it("says so in words, distinctly from stale", () => {
    expect(researchStateSentence(b)).toContain("Never scored");
    expect(researchStateSentence(b)).not.toContain("Not scored in");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T5 — an abstain is never a number.
// ─────────────────────────────────────────────────────────────────────────────
describe("T5 — an abstained signal → 'unavailable', never rendered as a number", () => {
  const now = new Date("2026-07-17T13:00:00Z");

  it("a null score is 'unavailable', not a score and not 'never'", () => {
    const b = buildResearchBlock(sig({ analyst_score: null }), now, "us");
    expect(b.state).toBe("unavailable");
    expect(b.score).toBeNull();
    expect(b.state).not.toBe("never"); // research DID run — that is a different fact
  });

  it("is distinguishable from 'never' by carrying a scored_at", () => {
    const abstained = buildResearchBlock(sig({ analyst_score: null }), now, "us");
    const never = buildResearchBlock(undefined, now, "us");
    expect(abstained.scored_at).not.toBeNull();
    expect(never.scored_at).toBeNull();
  });

  it("a NaN score does not leak through as a number", () => {
    const b = buildResearchBlock(sig({ analyst_score: NaN }), now, "us");
    expect(b.state).toBe("unavailable");
    expect(b.score).toBeNull();
  });

  it("never claims an age it cannot support", () => {
    const b = buildResearchBlock(sig({ analyst_score: null }), now, "us");
    expect(b.sessions_since).toBeNull();
    expect(b.days_since).toBeNull();
  });

  it("says 'abstained', and does not say a number", () => {
    const b = buildResearchBlock(sig({ analyst_score: null }), now, "us");
    expect(researchStateSentence(b)).toContain("abstained");
    expect(researchStateSentence(b)).not.toMatch(/\d/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T6 — US and India never cross-join.
// ─────────────────────────────────────────────────────────────────────────────
describe("T6 — the join key is (symbol, market), never symbol alone", () => {
  it("the same symbol in two markets indexes to two distinct entries", () => {
    const rows: ResearchSignalRow[] = [
      sig({ symbol: "ACME", market: "us", analyst_score: 90 }),
      sig({ symbol: "ACME", market: "india", analyst_score: 20 }),
    ];
    const idx = indexLatestSignals(rows);
    expect(idx.size).toBe(2);
    expect(idx.get(researchKey("ACME", "us"))!.analyst_score).toBe(90);
    expect(idx.get(researchKey("ACME", "india"))!.analyst_score).toBe(20);
  });

  it("an India holding does not resolve against a US row", () => {
    const idx = indexLatestSignals([sig({ symbol: "RELIANCE.NS", market: "us", analyst_score: 99 })]);
    // A US-market row for a .NS symbol must not satisfy the India book's lookup.
    expect(idx.get(researchKey("RELIANCE.NS", "india"))).toBeUndefined();
    const b = buildResearchBlock(idx.get(researchKey("RELIANCE.NS", "india")), new Date("2026-07-17T13:00:00Z"), "india");
    expect(b.state).toBe("never");
    expect(b.score).toBeNull(); // NOT 99
  });

  it("the key cannot be forged by a symbol containing the separator", () => {
    // researchKey is NUL-separated precisely so "A" + "us" and "A\0us" + "" cannot collide.
    expect(researchKey("ACME", "us")).not.toBe(researchKey("ACME us", ""));
  });

  it("latest-per-key wins, per market independently (rows arrive newest-first)", () => {
    const idx = indexLatestSignals([
      sig({ symbol: "ACME", market: "us", analyst_score: 70, created_at: "2026-07-16T13:00:00Z" }),
      sig({ symbol: "ACME", market: "us", analyst_score: 10, created_at: "2026-07-01T13:00:00Z" }),
    ]);
    expect(idx.get(researchKey("ACME", "us"))!.analyst_score).toBe(70);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T7 — is_holding changes what the score MEANS.
// ─────────────────────────────────────────────────────────────────────────────
describe("T7 — a is_holding:false row is a candidate score, not a holding verdict", () => {
  const now = new Date("2026-07-17T13:00:00Z");

  it("surfaces scored_as_holding=false for a screener-path row (every prod row, as of 2026-07-17)", () => {
    const b = buildResearchBlock(sig({ is_holding: false }), now, "us");
    expect(b.scored_as_holding).toBe(false);
  });

  it("surfaces scored_as_holding=true when research scored it AS a holding", () => {
    const b = buildResearchBlock(sig({ is_holding: true }), now, "us");
    expect(b.scored_as_holding).toBe(true);
  });

  it("AVGO's real row: a 'neutral' from the screener path — NOT evidence of 'no exit signal'", () => {
    // The direction gate can only emit `short` (a deterministic exit) when the
    // symbol was scored as HELD. AVGO was scored as a candidate, so its neutral
    // means the exit question was never asked — not that the answer was "no".
    const b = buildResearchBlock(sig({ direction: "neutral", is_holding: false }), now, "us");
    expect(b.direction).toBe("neutral");
    expect(b.scored_as_holding).toBe(false);
  });

  it("an unknown is_holding is null, not silently false — absent is not the same as denied", () => {
    const b = buildResearchBlock(sig({ is_holding: null }), now, "us");
    expect(b.scored_as_holding).toBeNull();
  });

  it("scored_as_holding is preserved on an abstain too", () => {
    const b = buildResearchBlock(sig({ analyst_score: null, is_holding: false }), now, "us");
    expect(b.state).toBe("unavailable");
    expect(b.scored_as_holding).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T8 — fail-soft: research absence never blanks the risk table.
// ─────────────────────────────────────────────────────────────────────────────
describe("T8 — research is the annotation; risk is the product", () => {
  // Models the route's contract: on an agent_signals error the holdings still
  // come back, with research=null and researchAvailable=false. The distinction
  // between "read failed" (null) and "read fine, nothing found" (state:'never')
  // is what lets the UI avoid claiming a symbol was never scored when in truth
  // we simply could not look.
  const packHoldings = (rows: Array<{ symbol: string; holding_risk_score: number }>, researchAvailable: boolean) => ({
    holdings: rows.map(r => ({
      ...r,
      research: researchAvailable
        ? buildResearchBlock(undefined, new Date("2026-07-17T13:00:00Z"), "us")
        : null,
    })),
    researchAvailable,
  });

  const rows = [{ symbol: "AVGO", holding_risk_score: 63 }, { symbol: "IBIT", holding_risk_score: 71 }];

  it("holdings still render when the research read fails", () => {
    const out = packHoldings(rows, false);
    expect(out.holdings).toHaveLength(2);
    expect(out.holdings.map(h => h.holding_risk_score)).toEqual([63, 71]);
  });

  it("a failed read is flagged, not silently blank", () => {
    const out = packHoldings(rows, false);
    expect(out.researchAvailable).toBe(false);
    expect(out.holdings.every(h => h.research === null)).toBe(true);
  });

  it("'read failed' (null) is distinguishable from 'read fine, never scored' (state:never)", () => {
    const failed = packHoldings(rows, false);
    const empty = packHoldings(rows, true);
    expect(failed.holdings[0].research).toBeNull();
    expect(empty.holdings[0].research).not.toBeNull();
    expect(empty.holdings[0].research!.state).toBe("never");
    // The bug this prevents: rendering "never scored" when we merely failed to look.
    expect(failed.researchAvailable).not.toBe(empty.researchAvailable);
  });

  it("a failed read never fabricates a score", () => {
    const out = packHoldings(rows, false);
    for (const h of out.holdings) expect(h.research?.score ?? null).toBeNull();
  });
});
