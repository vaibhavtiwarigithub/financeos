import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { toScorePoints, SCORE_DIMENSIONS, type ScoreSignalRow } from "@/lib/research/score-history";

const ROOT = resolve(__dirname, "..");
const code = (p: string) => readFileSync(resolve(ROOT, p), "utf8").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const ROUTE = code("app/api/research/scores/route.ts");
const PAGE = code("app/dashboard/research/[symbol]/page.tsx");

const row = (over: Partial<ScoreSignalRow> = {}): ScoreSignalRow => ({
  created_at: "2026-09-15T15:08:19Z",
  analyst_score: 52,
  fundamental_score: "70.00",
  technical_score: "0.00",
  sentiment_score: "76.00",
  macro_score: "73.00",
  insider_score: "50.00",
  direction: "neutral",
  conviction: 52,
  score_source: "deterministic_v1",
  scoring_version: "v1.0",
  ...over,
});

// The defect: Score History read paper_trades, so a symbol researched 56 times
// with zero trades showed "no scored paper trades found" while two months of
// dimension scores sat in agent_signals (STM, observed 2026-09-15).
describe("score history — research runs, not trades", () => {
  it("produces a point from a research run with no trade attached", () => {
    const [p] = toScorePoints([row()]);
    expect(p.date).toBe("2026-09-15");
    expect(p.analyst).toBe(52);
    expect(p.fundamental).toBe(70);
  });

  it("parses Postgres numerics, which arrive as strings", () => {
    const [p] = toScorePoints([row()]);
    for (const v of [p.fundamental, p.technical, p.sentiment, p.macro, p.insider]) {
      expect(typeof v).toBe("number");
    }
    // A real zero must survive as 0, not collapse to null — STM's technical
    // score genuinely reads 0, and showing it as "no data" would be a lie.
    expect(p.technical).toBe(0);
  });

  it("keeps every dimension the scorer writes", () => {
    // Name the dimensions explicitly. Looping over SCORE_DIMENSIONS to check
    // them made the test vacuous: deleting a dimension deleted its own
    // assertion, so dropping Insider passed cleanly.
    expect(SCORE_DIMENSIONS.map(d => d.key)).toEqual([
      "analyst", "fundamental", "technical", "sentiment", "macro", "insider",
    ]);
    const [p] = toScorePoints([row()]);
    expect(p.analyst).toBe(52);
    expect(p.fundamental).toBe(70);
    expect(p.technical).toBe(0);
    expect(p.sentiment).toBe(76);
    expect(p.macro).toBe(73);
    expect(p.insider).toBe(50);
  });

  it("collapses same-day runs to the LAST one and counts them", () => {
    // STM was researched twice on 2026-09-01. Two points on one x value render
    // as a spike that never happened.
    const points = toScorePoints([
      row({ created_at: "2026-09-01T09:00:00Z", analyst_score: 30 }),
      row({ created_at: "2026-09-01T18:00:00Z", analyst_score: 35 }),
    ]);
    expect(points).toHaveLength(1);
    expect(points[0].analyst).toBe(35);
    expect(points[0].runs).toBe(2);
  });

  it("never averages same-day runs into a score no run produced", () => {
    const points = toScorePoints([
      row({ created_at: "2026-09-01T09:00:00Z", analyst_score: 20 }),
      row({ created_at: "2026-09-01T18:00:00Z", analyst_score: 60 }),
    ]);
    expect(points[0].analyst).not.toBe(40);
    expect(points[0].analyst).toBe(60);
  });

  it("returns days in ascending order", () => {
    const points = toScorePoints([
      row({ created_at: "2026-08-31T10:00:00Z" }),
      row({ created_at: "2026-09-15T10:00:00Z" }),
      row({ created_at: "2026-09-02T10:00:00Z" }),
    ]);
    expect(points.map(p => p.date)).toEqual(["2026-08-31", "2026-09-02", "2026-09-15"]);
  });

  it("carries provenance so the chart never implies a score it cannot source", () => {
    const [p] = toScorePoints([row()]);
    expect(p.score_source).toBe("deterministic_v1");
    expect(p.scoring_version).toBe("v1.0");
  });

  it("survives junk rows instead of throwing", () => {
    const points = toScorePoints([
      row({ created_at: "" }),
      row({ analyst_score: null, fundamental_score: null }),
    ]);
    expect(points).toHaveLength(1);
    expect(points[0].analyst).toBeNull();
  });
});

describe("the scores route reads the right table", () => {
  it("queries agent_signals, not paper_trades", () => {
    expect(ROUTE.includes('from("agent_signals")')).toBe(true);
    expect(ROUTE.includes("paper_trades"), "still bound to trades").toBe(false);
  });

  it("is gated in the handler — owner or an allowlisted viewer (Deep Dive)", () => {
    // Opened to viewers 2026-09-15: it reads stored agent_signals only.
    expect(ROUTE.includes("requireViewerOrOwner(req)")).toBe(true);
    expect(ROUTE.includes("if (gate) return gate")).toBe(true);
  });

  it("scopes by symbol AND market, so India and US never mix", () => {
    expect(ROUTE.includes('.eq("symbol", symbol)')).toBe(true);
    expect(ROUTE.includes('.eq("market", market)')).toBe(true);
  });

  it("orders ascending — toScorePoints keeps the last run per day and relies on it", () => {
    expect(/order\("created_at",\s*\{\s*ascending:\s*true/.test(ROUTE)).toBe(true);
  });
});

describe("the tab plots scores against price, honestly", () => {
  it("no longer claims missing trades when a symbol simply was not researched", () => {
    expect(PAGE.includes("No scored paper trades found")).toBe(false);
    expect(PAGE.includes("No research runs recorded")).toBe(true);
  });

  it("gates the tab on research runs, not on trades", () => {
    expect(PAGE.includes("scorePoints.length === 0")).toBe(true);
  });

  it("draws price and scores on separate axes", () => {
    // Assert on the AXIS DECLARATIONS, not on yAxisId appearing somewhere: the
    // lines and reference lines carry yAxisId too, so a looser check passed
    // even with the right-hand axis deleted.
    const axes = PAGE.match(/<YAxis\b[\s\S]{0,240}?\/>/g) ?? [];
    const priceAxis = axes.filter(a => a.includes('yAxisId="price"') && a.includes('orientation="left"'));
    const scoreAxis = axes.filter(a => a.includes('yAxisId="score"') && a.includes('orientation="right"'));
    expect(priceAxis.length, "no left price axis").toBe(1);
    expect(scoreAxis.length, "no right 0-100 score axis").toBe(1);
    expect(scoreAxis[0]).toContain("domain={[0, 100]}");
  });

  it("breaks score lines across unresearched gaps rather than smoothing them", () => {
    // Price is continuous and may connect; scores must not.
    expect(PAGE.includes("connectNulls={false}"), "score lines would smooth over gaps").toBe(true);
  });
});
