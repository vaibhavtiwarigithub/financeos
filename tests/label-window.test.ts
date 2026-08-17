import { describe, it, expect } from "vitest";
import {
  CandleResolver,
  SkipLedger,
  forwardWindow,
  hasForwardCoverage,
  mergeCandles,
  rotatingOffset,
  type LabelCandle,
} from "@/lib/learning/label-window";

/** Sequential trading-day bars from `start`, weekends skipped for realism. */
function bars(start: string, n: number, price = 100): LabelCandle[] {
  const out: LabelCandle[] = [];
  const d = new Date(start + "T00:00:00Z");
  while (out.length < n) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) {
      const p = price + out.length;
      out.push({ date: d.toISOString().slice(0, 10), close: p, high: p + 1, low: p - 1 });
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

describe("forwardWindow — coverage, not row existence", () => {
  it("returns the entry bar plus exactly the forward sessions asked for", () => {
    const w = forwardWindow(bars("2026-07-20", 30), "2026-07-22", 20)!;
    expect(w.entry.date).toBe("2026-07-22");
    expect(w.after.length).toBeGreaterThanOrEqual(20);
    expect(w.after[0].date > w.entry.date).toBe(true);
  });

  it("refuses when the forward window is short by one session", () => {
    // 21 bars from the decision date = entry + 20 forward. Drop one.
    const series = bars("2026-07-22", 20);
    expect(hasForwardCoverage(series, "2026-07-22", 19)).toBe(true);
    expect(hasForwardCoverage(series, "2026-07-22", 20)).toBe(false);
  });

  it("refuses when no bar exists on or after the decision date", () => {
    const stale = bars("2026-06-01", 15); // 15 sessions from Jun 1 ends Jun 19
    expect(stale[stale.length - 1].date < "2026-07-22").toBe(true);
    expect(forwardWindow(stale, "2026-07-22", 2)).toBeNull();
  });

  it("a non-empty but stale series has zero coverage — the 2026-07-22 freeze", () => {
    const stale = bars("2026-06-01", 15); // ends well before the decision
    expect(stale.length).toBeGreaterThan(0);
    expect(hasForwardCoverage(stale, "2026-07-23", 2)).toBe(false);
  });
});

describe("mergeCandles", () => {
  it("unions by date, keeps ascending order, drops non-finite closes", () => {
    const merged = mergeCandles(
      [{ date: "2026-07-02", close: 2, high: 2, low: 2 }, { date: "2026-07-01", close: 1, high: 1, low: 1 }],
      [{ date: "2026-07-02", close: 99, high: 99, low: 99 }, { date: "2026-07-03", close: NaN, high: 3, low: 3 }],
    );
    expect(merged.map((c) => c.date)).toEqual(["2026-07-01", "2026-07-02"]);
    expect(merged[1].close).toBe(99); // later source wins
  });
});

describe("CandleResolver — W7 defect 1: stale-but-present cache must not short-circuit", () => {
  it("falls through to the provider when the cached slice lacks forward coverage", async () => {
    let providerCalls = 0;
    const resolver = new CandleResolver({
      cache: async () => bars("2026-06-01", 15),           // stale: ends before the decision
      provider: async () => { providerCalls++; return bars("2026-07-20", 40); },
    });

    const series = await resolver.resolve("us", "AAPL", "2026-07-23", 2, "2026-07-18");
    expect(providerCalls).toBe(1);
    expect(hasForwardCoverage(series, "2026-07-23", 2)).toBe(true);
  });

  it("does NOT call the provider when the cache already covers the window", async () => {
    let providerCalls = 0;
    const resolver = new CandleResolver({
      cache: async () => bars("2026-07-20", 40),
      provider: async () => { providerCalls++; return []; },
    });
    await resolver.resolve("us", "AAPL", "2026-07-22", 5, "2026-07-17");
    expect(providerCalls).toBe(0);
  });

  it("tries the provider at most once per symbol per run even when it cannot help", async () => {
    let providerCalls = 0;
    const resolver = new CandleResolver({
      cache: async () => [],
      provider: async () => { providerCalls++; return bars("2026-06-01", 10); },
    });
    for (let i = 0; i < 5; i++) await resolver.resolve("us", "DEAD", "2026-07-23", 2, "2026-07-18");
    expect(providerCalls).toBe(1);
  });
});

describe("CandleResolver — W7 defect 2: the memo must be range-aware", () => {
  it("serves an h20 window after a narrow h2 request for the same symbol", async () => {
    let providerCalls = 0;
    const resolver = new CandleResolver({
      // The cache only ever has a 5-bar sliver — enough for h2, never for h20.
      cache: async () => bars("2026-07-22", 5),
      provider: async () => { providerCalls++; return bars("2026-07-22", 60); },
    });

    // h2 first: satisfied by the cache alone, memoises a narrow series.
    const h2 = await resolver.resolve("us", "AVGO", "2026-07-22", 2, "2026-07-17");
    expect(hasForwardCoverage(h2, "2026-07-22", 2)).toBe(true);
    expect(providerCalls).toBe(0);

    // h20 next: the old memo returned the narrow series and starved this.
    const h20 = await resolver.resolve("us", "AVGO", "2026-07-22", 20, "2026-07-17");
    expect(providerCalls).toBe(1);
    expect(hasForwardCoverage(h20, "2026-07-22", 20)).toBe(true);
  });

  it("re-reads the cache when a later horizon reaches further back", async () => {
    const sinceSeen: string[] = [];
    const resolver = new CandleResolver({
      cache: async (_m, _s, since) => { sinceSeen.push(since); return bars(since, 60); },
      provider: async () => [],
    });
    await resolver.resolve("us", "VOO", "2026-07-22", 2, "2026-07-17");
    await resolver.resolve("us", "VOO", "2026-06-01", 20, "2026-05-27"); // older
    await resolver.resolve("us", "VOO", "2026-07-22", 5, "2026-07-17");  // not older — no re-read
    expect(sinceSeen).toEqual(["2026-07-17", "2026-05-27"]);
  });

  it("serialises concurrent requests for one symbol into a single provider fetch", async () => {
    let providerCalls = 0;
    const resolver = new CandleResolver({
      cache: async () => [],
      provider: async () => {
        providerCalls++;
        await new Promise((r) => setTimeout(r, 5));
        return bars("2026-07-20", 60);
      },
    });
    const all = await Promise.all(
      [2, 5, 10, 20].map((h) => resolver.resolve("us", "NVDA", "2026-07-22", h, "2026-07-17")),
    );
    expect(providerCalls).toBe(1);
    for (const s of all) expect(s.length).toBe(60);
  });
});

describe("SkipLedger — a zero-output run must say why, and for which symbols", () => {
  it("counts by reason and by symbol", () => {
    const led = new SkipLedger();
    led.add("window_incomplete", "us", "LNC");
    led.add("window_incomplete", "us", "LNC");
    led.add("no_candles", "us", "MSFT");
    led.add("window_incomplete", "india", "TCS.NS");

    expect(led.total).toBe(4);
    expect(led.byReason.window_incomplete).toBe(3);
    expect(led.byReason.no_candles).toBe(1);
    expect(led.byReason.insert_failed).toBeUndefined();
    expect(led.topSymbols(1)).toEqual([{ key: "us:LNC:window_incomplete", count: 2 }]);
  });
});

describe("rotatingOffset — W8: a bad prefix cannot monopolise every run", () => {
  it("stays at 0 when everything fits in one page", () => {
    expect(rotatingOffset(150, 200, 12345)).toBe(0);
    expect(rotatingOffset(0, 200, 12345)).toBe(0);
  });

  it("advances by whole pages and is deterministic per day", () => {
    const total = 1738, page = 200; // the real US backlog
    const a = rotatingOffset(total, page, 20_000);
    expect(a).toBe(rotatingOffset(total, page, 20_000));
    expect(a % page).toBe(0);
    expect(a).toBeLessThan(total + page);
  });

  it("visits every page over consecutive days — newer rows are always reachable", () => {
    const total = 1738, page = 200;
    const pages = Math.ceil(total / page); // 9
    const visited = new Set(
      Array.from({ length: pages }, (_, d) => rotatingOffset(total, page, 20_000 + d)),
    );
    expect(visited.size).toBe(pages);
    // Crucially: the LAST page (the newest observations) is reached.
    expect(visited.has((pages - 1) * page)).toBe(true);
  });
});

/**
 * W8 starvation, end to end over the scan/success budget split. Models the
 * production shape: the oldest 400 rows can never be labelled, and the old
 * loader spent its whole 200-row budget on them every single run.
 */
describe("scan budget vs success budget", () => {
  const PAGE = 200;

  /** Mirrors runPass: page forward, skipping unlabelable rows, until the
   *  success budget fills or the scan cap is spent. */
  function pass(rows: string[], startOffset: number, successBudget: number, scanCap: number) {
    const labelled: string[] = [];
    let scanned = 0;
    for (let off = startOffset; scanned < scanCap && labelled.length < successBudget; off += PAGE) {
      const page = rows.slice(off, off + PAGE);
      scanned += page.length;
      for (const r of page) {
        if (labelled.length >= successBudget) break;
        if (r !== "BROKEN") labelled.push(r);
      }
      if (page.length < PAGE) break;
    }
    return { labelled, scanned };
  }

  const rows = [
    ...Array.from({ length: 400 }, () => "BROKEN"),
    ...Array.from({ length: 1338 }, (_, i) => `ok-${i}`),
  ];

  it("the old design labels nothing: 200 slots consumed by a permanently-failing prefix", () => {
    const oldStyle = rows.slice(0, 200).filter((r) => r !== "BROKEN");
    expect(oldStyle).toHaveLength(0); // {matured:0, skipped:200}
  });

  it("pages past the broken prefix and still produces a full budget of labels", () => {
    const { labelled, scanned } = pass(rows, 0, 200, 2000);
    expect(labelled).toHaveLength(200);
    expect(labelled[0]).toBe("ok-0");
    expect(scanned).toBeGreaterThan(400); // skips spent scan budget, not label budget
  });

  it("the scan cap bounds the work even when nothing is labelable", () => {
    const allBroken = Array.from({ length: 5000 }, () => "BROKEN");
    const { labelled, scanned } = pass(allBroken, 0, 200, 1000);
    expect(labelled).toHaveLength(0);
    expect(scanned).toBe(1000); // bounded — the run terminates
  });

  it("the rotating pass reaches rows the oldest-first pass never gets to", () => {
    // 1738 rows over 200-row pages = 9 pages; day 20_003 rotates to page 5.
    const offset = rotatingOffset(rows.length, PAGE, 20_003);
    expect(offset).toBeGreaterThan(0);
    const { labelled } = pass(rows, offset, 100, 1000);
    const oldestFirst = new Set(pass(rows, 0, 100, 1000).labelled);
    expect(labelled.length).toBeGreaterThan(0);
    expect(labelled.some((r) => !oldestFirst.has(r))).toBe(true);
  });
});

// ── Long-horizon coverage (h60 / h120, added 2026-08-17) ─────────────────────
// The resolver fetches each symbol AT MOST ONCE per run (providerTried is keyed
// market:symbol), so that single fetch has to satisfy the LONGEST horizon in
// play. India's provider used to fetch "3mo" (~63 bars) — enough for h20, never
// enough for h120 — and because the fetch is not retried, short coverage would
// have starved the long horizons silently for the whole run.
describe("long-horizon forward coverage", () => {
  const DECISION = "2026-01-05";

  it("a 3mo-sized series cannot cover h120 — the regression the range widening prevents", () => {
    const shallow = bars("2026-01-02", 63); // ~3 months of sessions
    expect(hasForwardCoverage(shallow, DECISION, 20)).toBe(true);
    // h60 clears only because the decision sits at the very front of the series
    // (61 forward bars, 1 to spare) — a decision even two sessions later fails.
    expect(hasForwardCoverage(shallow, DECISION, 60)).toBe(true);
    expect(hasForwardCoverage(shallow, "2026-01-07", 60)).toBe(false);
    // h120 is unreachable from a 3mo series at ANY decision date in it.
    expect(hasForwardCoverage(shallow, DECISION, 120)).toBe(false);
  });

  it("a 2y-sized series covers h120, and the window is exactly 120 forward sessions", () => {
    const deep = bars("2026-01-02", 400);
    expect(hasForwardCoverage(deep, DECISION, 120)).toBe(true);
    const w = forwardWindow(deep, DECISION, 120)!;
    expect(w.entry.date).toBe(DECISION);
    expect(w.after.every((c) => c.date > w.entry.date)).toBe(true);
    expect(w.after.length).toBeGreaterThanOrEqual(120);
    // The label reads after[h-1] as the exit bar — it must exist.
    expect(w.after[119]).toBeDefined();
  });

  it("one provider fetch serves every horizon — a short first fetch would starve h120", async () => {
    const deep = bars("2026-01-02", 400);
    const r = new CandleResolver({
      cache: async () => [],
      provider: async () => deep,
    });
    // Short horizon first, exactly as the HORIZONS loop orders them.
    await r.resolve("us", "AAPL", DECISION, 2, "2025-12-28");
    const series = await r.resolve("us", "AAPL", DECISION, 120, "2025-12-28");
    expect(r.providerFetches).toBe(1);
    expect(hasForwardCoverage(series, DECISION, 120)).toBe(true);
  });
});
