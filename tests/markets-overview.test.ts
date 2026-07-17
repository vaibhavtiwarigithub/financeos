import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Real Massive grouped values, pulled live 2026-07-16/17 for the 07-16, 07-15
// and 07-14 sessions. `o` is retained ONLY so the tests can assert that the
// route does NOT compute the intraday (c - o) / o move.
const S0716: Record<string, { o: number; c: number }> = {
  SPY: { o: 752.76, c: 750.72 }, QQQ: { o: 718.0, c: 717.0 }, DIA: { o: 526.0, c: 525.0 }, VIXY: { o: 20.1, c: 20.56 },
  XLK: { o: 179.0, c: 177.52 }, XLF: { o: 56.6, c: 56.8 }, XLE: { o: 56.6, c: 57.02 }, XLV: { o: 158.4, c: 161.8 },
  XLI: { o: 180.1, c: 179.3 }, XLY: { o: 117.1, c: 116.04 }, XLP: { o: 83.5, c: 83.9 }, XLRE: { o: 44.71, c: 45.46 },
  XLU: { o: 45.3, c: 45.41 }, XLB: { o: 50.6, c: 50.89 }, XLC: { o: 113.4, c: 111.64 },
};
const S0715: Record<string, number> = {
  SPY: 754.81, QQQ: 717.74, DIA: 525.95, VIXY: 20.06,
  XLK: 181.58, XLF: 56.56, XLE: 56.5, XLV: 158.29, XLI: 180.06,
  XLY: 117, XLP: 83.47, XLRE: 44.56, XLU: 45.22, XLB: 50.5, XLC: 113.38,
};

const TS_0716 = 1784232000000;

function groupedOk(closes: Record<string, number | { o: number; c: number }>) {
  return {
    status: "OK",
    results: Object.entries(closes).map(([T, v]) =>
      typeof v === "number" ? { T, o: v, c: v, t: TS_0716 } : { T, o: v.o, c: v.c, t: TS_0716 }
    ),
  };
}
const NO_SESSION = { status: "OK", adjusted: true }; // holiday: 200, no results

function res(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const calls: string[] = [];

function installFetch(handler: (date: string) => Response) {
  vi.stubGlobal("fetch", vi.fn(async (input: any) => {
    const url = String(input);
    calls.push(url);
    const date = url.match(/market\/stocks\/(\d{4}-\d{2}-\d{2})/)?.[1];
    if (!date) throw new Error(`unexpected non-grouped request: ${url}`);
    return handler(date);
  }));
}

const groupedDates = () =>
  calls.map((c) => c.match(/market\/stocks\/(\d{4}-\d{2}-\d{2})/)?.[1]).filter(Boolean);

async function loadRoute() {
  vi.resetModules();
  return await import("@/app/api/markets/overview/route");
}

/** Freeze the clock so "today" in ET is deterministic. 2026-07-17 00:02 ET. */
function freezeAt(iso: string) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
}

beforeEach(() => {
  vi.resetModules(); // route holds module-level caches — no cross-test leakage
  calls.length = 0;
  process.env.MASSIVE_API_KEY = "test-key";
  freezeAt("2026-07-17T04:02:00Z"); // = 2026-07-17 00:02 ET
});
afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const happyPath = (date: string) => {
  if (date === "2026-07-16") return res(200, groupedOk(S0716));
  if (date === "2026-07-15") return res(200, groupedOk(S0715));
  return res(200, NO_SESSION);
};

describe("/api/markets/overview — daily change is close vs PRIOR close", () => {
  it("reports XLK -2.24% (close 177.52 vs prior close 181.58), NOT the -0.83% intraday move", async () => {
    installFetch(happyPath);
    const { GET } = await loadRoute();
    const body = await (await GET()).json();

    const xlk = body.sectors.find((s: any) => s.symbol === "XLK");
    expect(xlk.status).toBe("ok");
    expect(xlk.price).toBe(177.52);
    expect(xlk.changePct).toBe(-2.24);
    // The old route computed (c - o) / o = -0.83%, understating the move 2.7x.
    expect(xlk.changePct).not.toBe(-0.83);

    const spy = body.indices.find((i: any) => i.symbol === "SPY");
    expect(spy.changePct).toBe(-0.54);
    expect(spy.changePct).not.toBe(-0.27); // its intraday move

    expect(body.sessionDate).toBe("2026-07-16");
    expect(body.priorCloseDate).toBe("2026-07-15");
    expect(body.stale).toBe(false);
    expect(body.unavailableCount).toBe(0);
  });

  it("keeps the correct SIGN when a session gaps down and rallies (XLRE)", async () => {
    installFetch(happyPath);
    const { GET } = await loadRoute();
    const body = await (await GET()).json();

    const xlre = body.sectors.find((s: any) => s.symbol === "XLRE");
    // Intraday 44.71 → 45.46 vs prior close 44.56 — both positive here, but the
    // route must be measuring against the PRIOR CLOSE, not the open.
    expect(xlre.changePct).toBe(2.02); // (45.46 - 44.56) / 44.56
    const intraday = Number((((45.46 - 44.71) / 44.71) * 100).toFixed(2)); // 1.68
    expect(xlre.changePct).not.toBe(intraday);
  });

  it("serves ALL 15 symbols from 3 grouped requests here, and never one-per-symbol", async () => {
    installFetch(happyPath);
    const { GET } = await loadRoute();
    const body = await (await GET()).json();

    // The provider key allows ~5 requests/minute (verified live). The old route
    // fired 15 parallel per-symbol /prev calls, so ~10 failed into silent zeros.
    // Here "today" (07-17) has not published yet, so the walk probes
    // 07-17 (empty) → 07-16 → 07-15: 3 requests for all 15 symbols. Once 07-17
    // publishes it settles to 2. Either way it stays inside the budget.
    expect(groupedDates()).toEqual(["2026-07-17", "2026-07-16", "2026-07-15"]);
    expect(calls.length).toBe(3);
    expect(calls.length).toBeLessThanOrEqual(5);
    expect(body.indices.length + body.sectors.length).toBe(15);
    for (const q of [...body.indices, ...body.sectors]) expect(q.status).toBe("ok");
  });

  it("settles to exactly TWO requests once today's session has published", async () => {
    installFetch((date) => {
      if (date === "2026-07-17") return res(200, groupedOk(S0716)); // published
      if (date === "2026-07-16") return res(200, groupedOk(S0715));
      return res(200, NO_SESSION);
    });
    const { GET } = await loadRoute();
    const body = await (await GET()).json();

    expect(calls.length).toBe(2);
    expect(groupedDates()).toEqual(["2026-07-17", "2026-07-16"]);
    expect(body.sessionDate).toBe("2026-07-17");
  });

  it("puts every symbol on the SAME session", async () => {
    installFetch(happyPath);
    const { GET } = await loadRoute();
    const body = await (await GET()).json();
    expect(body.sessionDate).toBe("2026-07-16");
    // Spot-check against the fixture's 07-16 closes.
    expect(body.indices.find((i: any) => i.symbol === "VIXY").price).toBe(20.56);
    expect(body.sectors.find((s: any) => s.symbol === "XLV").price).toBe(161.8);
  });

  it("walks back past a holiday and past an unpublished session (403)", async () => {
    installFetch((date) => {
      if (date === "2026-07-17") return res(403, { error: "before end of day" });
      if (date === "2026-07-16") return res(200, NO_SESSION); // holiday
      if (date === "2026-07-15") return res(200, groupedOk(S0716));
      if (date === "2026-07-14") return res(200, groupedOk(S0715));
      return res(200, NO_SESSION);
    });
    const { GET } = await loadRoute();
    const body = await (await GET()).json();

    expect(groupedDates()).toEqual(["2026-07-17", "2026-07-16", "2026-07-15", "2026-07-14"]);
    expect(body.sessionDate).toBe("2026-07-15");
    expect(body.priorCloseDate).toBe("2026-07-14");
    expect(body.sectors.find((s: any) => s.symbol === "XLK").changePct).toBe(-2.24);
  });

  it("skips weekends when today is a Monday", async () => {
    freezeAt("2026-07-20T14:00:00Z"); // Monday 10:00 ET, session not yet published
    installFetch((date) => {
      if (date === "2026-07-20") return res(403, { error: "before end of day" });
      if (date === "2026-07-17") return res(200, groupedOk(S0716));
      if (date === "2026-07-16") return res(200, groupedOk(S0715));
      return res(200, NO_SESSION);
    });
    const { GET } = await loadRoute();
    const body = await (await GET()).json();

    // 07-18 and 07-19 are the weekend and must never be requested.
    expect(groupedDates()).toEqual(["2026-07-20", "2026-07-17", "2026-07-16"]);
    expect(body.sessionDate).toBe("2026-07-17");
    expect(body.priorCloseDate).toBe("2026-07-16");
  });
});

describe("/api/markets/overview — unavailable must never render as flat", () => {
  it("surfaces a rate limit as degraded instead of a wall of +0.00%", async () => {
    // The provider signals this as HTTP 200 with an ERROR body.
    installFetch(() =>
      res(200, {
        status: "ERROR",
        error: "You've exceeded the maximum requests per minute, please wait or upgrade",
      })
    );
    const { GET } = await loadRoute();
    const body = await (await GET()).json();

    expect(body.degraded).toMatch(/rate limit/i);
    expect(body.stale).toBe(true);
    for (const q of [...body.indices, ...body.sectors]) {
      expect(q.status).toBe("unavailable");
      expect(q.changePct).toBeNull();
      expect(q.changePct).not.toBe(0); // the exact regression
    }
  });

  it("surfaces an HTTP 429 rate limit as degraded", async () => {
    installFetch(() => res(429, { error: "rate limited" }));
    const { GET } = await loadRoute();
    const body = await (await GET()).json();
    expect(body.degraded).toMatch(/rate limit/i);
  });

  it("marks a symbol missing from the session data as unavailable, not 0.00%", async () => {
    const partial = { ...S0716 };
    delete (partial as any).XLE;
    installFetch((date) => {
      if (date === "2026-07-16") return res(200, groupedOk(partial));
      if (date === "2026-07-15") return res(200, groupedOk(S0715));
      return res(200, NO_SESSION);
    });
    const { GET } = await loadRoute();
    const body = await (await GET()).json();

    const xle = body.sectors.find((s: any) => s.symbol === "XLE");
    expect(xle.status).toBe("unavailable");
    expect(xle.price).toBeNull();
    expect(xle.changePct).toBeNull();
    expect(xle.changePct).not.toBe(0);
    expect(body.unavailableCount).toBe(1);
    expect(body.stale).toBe(true);
    // Everything else still resolves.
    expect(body.sectors.find((s: any) => s.symbol === "XLK").changePct).toBe(-2.24);
  });

  it("marks a symbol with no PRIOR close as unavailable while keeping its price", async () => {
    const priorPartial = { ...S0715 };
    delete priorPartial.XLK;
    installFetch((date) => {
      if (date === "2026-07-16") return res(200, groupedOk(S0716));
      if (date === "2026-07-15") return res(200, groupedOk(priorPartial));
      return res(200, NO_SESSION);
    });
    const { GET } = await loadRoute();
    const body = await (await GET()).json();

    const xlk = body.sectors.find((s: any) => s.symbol === "XLK");
    expect(xlk.status).toBe("unavailable");
    expect(xlk.price).toBe(177.52); // the close IS known
    expect(xlk.changePct).toBeNull(); // the change is NOT
    expect(xlk.reason).toMatch(/prior close/i);
  });

  it("returns an explicit degraded payload when the API key is missing", async () => {
    delete process.env.MASSIVE_API_KEY;
    installFetch(() => res(200, NO_SESSION));
    const { GET } = await loadRoute();
    const body = await (await GET()).json();

    expect(body.degraded).toMatch(/MASSIVE_API_KEY/);
    expect(body.stale).toBe(true);
    expect(body.unavailableCount).toBe(15);
    // The old route returned price/change/changePct all 0 with a `stale` field
    // the client never read — every index and sector rendered exactly flat.
    for (const q of [...body.indices, ...body.sectors]) {
      expect(q.price).toBeNull();
      expect(q.changePct).toBeNull();
      expect(q.status).toBe("unavailable");
    }
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("does not cache a degraded payload — it clears as soon as the provider recovers", async () => {
    let limited = true;
    installFetch((date) => {
      if (limited) return res(429, { error: "rate limited" });
      return happyPath(date);
    });
    const { GET } = await loadRoute();

    const first = await (await GET()).json();
    expect(first.degraded).toMatch(/rate limit/i);

    limited = false;
    const second = await (await GET()).json();
    expect(second.degraded).toBeUndefined();
    expect(second.sectors.find((s: any) => s.symbol === "XLK").changePct).toBe(-2.24);
  });
});
