import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { holdingMovers } from "@/lib/risk/holding-movers";

const ROOT = resolve(__dirname, "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Minimal price_cache stub: records the query and returns fixed rows. */
function svcWith(rows: Array<{ symbol: string; date: string; close: number }>) {
  const calls: string[] = [];
  const svc = {
    from(table: string) {
      calls.push(table);
      const q: any = {
        select: () => q, in: () => q, order: () => q,
        limit: () => Promise.resolve({ data: rows }),
      };
      return q;
    },
  };
  return { svc: svc as any, calls };
}

describe("movers are cache-only, as the cost rule requires", () => {
  it("reads price_cache and nothing else", async () => {
    const { svc, calls } = svcWith([
      { symbol: "AAA", date: "2026-09-11", close: 110 },
      { symbol: "AAA", date: "2026-09-10", close: 100 },
    ]);
    await holdingMovers(svc, ["AAA"]);
    expect(calls).toEqual(["price_cache"]);
  });

  it("imports no provider or fetcher at all", () => {
    const src = code(read("lib/risk/holding-movers.ts"));
    for (const banned in { fetch: 1, yahoo: 1, massive: 1, eodhd: 1, twelvedata: 1, alpha: 1, "https://": 1 }) {
      expect(src.toLowerCase().includes(banned.toLowerCase()), `references ${banned}`).toBe(false);
    }
  });
});

describe("a partial list says it is partial", () => {
  it("names the holdings it could not rank instead of dropping them silently", async () => {
    // Silently omitting an uncached holding could hide the very worst loser and
    // present a leaderboard that looks complete.
    const { svc } = svcWith([
      { symbol: "AAA", date: "2026-09-11", close: 110 },
      { symbol: "AAA", date: "2026-09-10", close: 100 },
    ]);
    const res = await holdingMovers(svc, ["AAA", "NOCACHE", "ALSOMISSING"]);
    expect(res.uncovered).toEqual(["ALSOMISSING", "NOCACHE"]);
    expect(res.gainers.map((g) => g.symbol)).toEqual(["AAA"]);
  });

  it("treats a single cached session as not rankable — one close is not a move", async () => {
    const { svc } = svcWith([{ symbol: "AAA", date: "2026-09-11", close: 110 }]);
    const res = await holdingMovers(svc, ["AAA"]);
    expect(res.uncovered).toEqual(["AAA"]);
    expect(res.gainers).toEqual([]);
  });
});

describe("the move is a true daily change", () => {
  const rows = [
    { symbol: "UP", date: "2026-09-11", close: 110 },
    { symbol: "UP", date: "2026-09-10", close: 100 },
    { symbol: "DOWN", date: "2026-09-11", close: 90 },
    { symbol: "DOWN", date: "2026-09-10", close: 100 },
    { symbol: "FLAT", date: "2026-09-11", close: 100 },
    { symbol: "FLAT", date: "2026-09-10", close: 100 },
  ];

  it("computes close over previous close, not close minus open", async () => {
    const { svc } = svcWith(rows);
    const res = await holdingMovers(svc, ["UP", "DOWN", "FLAT"]);
    expect(res.gainers[0]).toMatchObject({ symbol: "UP" });
    expect(res.gainers[0].changePct).toBeCloseTo(0.1, 6);
    expect(res.losers[0]).toMatchObject({ symbol: "DOWN" });
    expect(res.losers[0].changePct).toBeCloseTo(-0.1, 6);
  });

  it("puts an unchanged holding on neither side", async () => {
    const { svc } = svcWith(rows);
    const res = await holdingMovers(svc, ["UP", "DOWN", "FLAT"]);
    const named = [...res.gainers, ...res.losers].map((m) => m.symbol);
    expect(named).not.toContain("FLAT");
  });

  it("never lists the same symbol as both a gainer and a loser", async () => {
    const { svc } = svcWith(rows);
    const res = await holdingMovers(svc, ["UP", "DOWN", "FLAT"]);
    const g = new Set(res.gainers.map((m) => m.symbol));
    for (const l of res.losers) expect(g.has(l.symbol)).toBe(false);
  });

  it("orders losers worst-first", async () => {
    const { svc } = svcWith([
      { symbol: "BAD", date: "2026-09-11", close: 50 }, { symbol: "BAD", date: "2026-09-10", close: 100 },
      { symbol: "MILD", date: "2026-09-11", close: 99 }, { symbol: "MILD", date: "2026-09-10", close: 100 },
    ]);
    const res = await holdingMovers(svc, ["BAD", "MILD"]);
    expect(res.losers.map((m) => m.symbol)).toEqual(["BAD", "MILD"]);
  });

  it("returns an empty, honest result for no holdings", async () => {
    const { svc, calls } = svcWith([]);
    const res = await holdingMovers(svc, []);
    expect(res).toEqual({ gainers: [], losers: [], uncovered: [], asOfDate: null });
    expect(calls).toEqual([]);   // no query at all for an empty portfolio
  });
});

describe("the dial appears on the owner's page too", () => {
  it("the owner's risk page uses the shared dial, not a second implementation", () => {
    const page = read("components/dashboard/PortfolioRiskPage.tsx");
    expect(page.includes('from "@/components/dashboard/RiskDial"')).toBe(true);
    expect(page.includes("<RiskDial")).toBe(true);
    expect(page.includes("explainPortfolioRisk")).toBe(true);
  });
});

describe("System Health shows how long a fault has been open", () => {
  const card = read("components/dashboard/SystemHealthCard.tsx");

  it("renders an age on every alert row", () => {
    // Without this a 61-day-old outage looks identical to a one-hour blip,
    // which is how a real two-month Kite outage read as ambient noise.
    expect(card.includes("ageBadge(a.created_at)")).toBe(true);
  });

  it("calls a long-running fault STUCK rather than leaving it to a timestamp", () => {
    expect(card.includes("STUCK ")).toBe(true);
    expect(card.includes("days >= 7")).toBe(true);
  });

  it("counts stuck faults in the header summary", () => {
    expect(card.includes("nStuck")).toBe(true);
    expect(card.includes("stuck >7d")).toBe(true);
  });
});
