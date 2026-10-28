import { describe, expect, it } from "vitest";
import {
  aggregatePaperExitAccuracy,
  readPaperAccuracyRecoveryStatus,
} from "@/lib/kill-switches";

const NOW = Date.parse("2026-10-28T20:00:00.000Z");

function rowsFor(wins: number, losses: number, options: { taintedWins?: number } = {}) {
  const rows = Array.from({ length: wins + losses }, (_, i) => {
    const isWin = i < wins;
    return {
      symbol: `SYM${i}`,
      qty: 1,
      fill_price: 100,
      realized_pnl: isWin ? 1 : -1,
      closed_at: new Date(NOW - (i + 1) * 60_000).toISOString(),
      tainted: isWin && i < (options.taintedWins ?? 0),
    };
  });
  return rows;
}

function supabaseRows(data: unknown, error: unknown = null) {
  const calls: { market?: string; limit?: number } = {};
  const query = {
    select() { return this; },
    not() { return this; },
    order() { return this; },
    limit(value: number) { calls.limit = value; return this; },
    eq(column: string, value: string) {
      if (column === "market") calls.market = value;
      return Promise.resolve({ data, error });
    },
  };
  return { client: { from: () => query }, calls };
}

describe("paper kill-switch recovery status", () => {
  it("reports a blocked gate from the same 30-day directional episode math", async () => {
    const { client } = supabaseRows(rowsFor(7, 14));
    const status = await readPaperAccuracyRecoveryStatus(client, "us", 35, NOW);

    expect(status).toMatchObject({
      state: "blocked", wins: 7, losses: 14, directionalEpisodes: 21,
      thresholdPct: 35, minimumEpisodes: 20, windowDays: 30,
    });
    expect(status.winRatePct).toBeCloseTo(100 * 7 / 21, 10);
    expect(aggregatePaperExitAccuracy(rowsFor(7, 14), NOW)).toEqual({ wins: 7, total: 21, episodes: 21 });
  });

  it("treats a rate exactly at the threshold as clear, without calling it reset-eligible", async () => {
    const { client } = supabaseRows(rowsFor(7, 13));
    const status = await readPaperAccuracyRecoveryStatus(client, "us", 35, NOW);
    expect(status.state).toBe("clear");
    expect(status.winRatePct).toBe(35);
  });

  it("labels fewer than 20 directional episodes insufficient, never as a pass", async () => {
    const { client } = supabaseRows(rowsFor(19, 0));
    const status = await readPaperAccuracyRecoveryStatus(client, "us", 35, NOW);
    expect(status).toMatchObject({ state: "insufficient", wins: 19, losses: 0, directionalEpisodes: 19, winRatePct: 100 });
    expect(aggregatePaperExitAccuracy(rowsFor(19, 0), NOW)).toBeNull();
  });

  it("excludes tainted episodes and stays market-scoped", async () => {
    const data = rowsFor(8, 12, { taintedWins: 2 });
    const { client, calls } = supabaseRows(data);
    const status = await readPaperAccuracyRecoveryStatus(client, "india", 35, NOW);
    expect(calls).toEqual({ market: "india", limit: 5001 });
    expect(status).toMatchObject({ state: "insufficient", wins: 6, losses: 12, directionalEpisodes: 18 });
  });

  it("reports unavailable on failed or unbounded reads instead of implying insufficient data", async () => {
    const failed = await readPaperAccuracyRecoveryStatus(supabaseRows(null, new Error("db failure")).client, "us", 35, NOW);
    const overflow = await readPaperAccuracyRecoveryStatus(supabaseRows(Array(5001).fill({})).client, "us", 35, NOW);
    const unknownThreshold = await readPaperAccuracyRecoveryStatus(supabaseRows([]).client, "us", null, NOW);
    expect(failed.state).toBe("unavailable");
    expect(overflow.state).toBe("unavailable");
    expect(unknownThreshold.state).toBe("unavailable");
  });
});
