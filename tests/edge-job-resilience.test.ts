import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isTransientSupabaseError, withSupabaseRetry } from "@/lib/supabase/transient";

const ROOT = resolve(__dirname, "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const IC = code(read("app/api/agents/edge-ic/route.ts"));
const SCOUT = code(read("app/api/agents/edge-scout/route.ts"));
const READINESS = code(read("app/api/agents/edge-readiness/route.ts"));
const SWEEP = code(read("app/api/validation/sweep/route.ts"));

// Both edge jobs died on 2026-09-14 to the same cause, confirmed from production:
//   EdgeIC:    "edge market status failed (us/signed_adx_14): Gateway Timeout"
//   EdgeScout: "Universe=0" — same timeout, but swallowed and reported as a DATA
//              finding, while india_screen_cache held 1,698 rows written at 10:00,
//              90 minutes before the 11:30 run.

describe("transient is narrow — a real defect must still fail loudly", () => {
  it("treats gateway and network hiccups as transient", () => {
    for (const m of ["Gateway Timeout", "canceling statement due to statement timeout",
                     "fetch failed", "ECONNRESET", "503 Service Unavailable", "socket hang up"]) {
      expect(isTransientSupabaseError(m), m).toBe(true);
    }
  });

  it("does NOT retry a real error, which would turn a clear failure into a slow one", () => {
    for (const m of ['duplicate key value violates unique constraint "x"',
                     "permission denied for table edge_market_status",
                     'column "nope" does not exist',
                     "new row violates row-level security policy"]) {
      expect(isTransientSupabaseError(m), m).toBe(false);
    }
    expect(isTransientSupabaseError(null)).toBe(false);
    expect(isTransientSupabaseError("")).toBe(false);
  });
});

describe("withSupabaseRetry survives a hiccup and gives up on a defect", () => {
  const noSleep = async () => {};

  it("returns success once the transient failure clears", async () => {
    let calls = 0;
    const res = await withSupabaseRetry(async () => {
      calls++;
      return calls < 3 ? { error: { message: "Gateway Timeout" } } : { error: null };
    }, { retries: 2, sleep: noSleep });
    expect(calls).toBe(3);
    expect(res.error).toBeNull();
  });

  it("does not retry a non-transient error even once", async () => {
    let calls = 0;
    const res = await withSupabaseRetry(async () => {
      calls++;
      return { error: { message: "permission denied" } };
    }, { retries: 3, sleep: noSleep });
    expect(calls).toBe(1);
    expect(res.error?.message).toBe("permission denied");
  });

  it("gives up after the bound and surfaces the last error", async () => {
    let calls = 0;
    const res = await withSupabaseRetry(async () => {
      calls++;
      return { error: { message: "Gateway Timeout" } };
    }, { retries: 2, sleep: noSleep });
    expect(calls).toBe(3);               // initial + 2 retries, never unbounded
    expect(res.error?.message).toBe("Gateway Timeout");
  });

  it("passes the result through untouched on first success", async () => {
    const res = await withSupabaseRetry(async () => ({ error: null, data: [{ id: "a" }] }));
    expect(res.data).toEqual([{ id: "a" }]);
  });
});

describe("EdgeIC no longer loses a run to one slow round-trip", () => {
  it("writes edge status in ONE batched upsert, not one request per edge", () => {
    expect(IC.includes("statusRows.length")).toBe(true);
    expect(IC.includes('svc.from("edge_market_status").upsert(statusRows')).toBe(true);
    // The old shape: a per-edge upsert inside the loop.
    expect(/for \(const \[edgeId, status\][\s\S]{0,400}?upsert\(\{/.test(IC),
      "still upserting one row per edge inside the loop").toBe(false);
  });

  it("retries the writes, which are keyed upserts and so safe to repeat", () => {
    expect(IC.includes("withSupabaseRetry")).toBe(true);
    expect(IC.includes('onConflict: "edge_id,market"')).toBe(true);
    expect(IC.includes('onConflict: "run_fingerprint"')).toBe(true);
  });
});

describe("EdgeScout tells a broken query apart from an empty universe", () => {
  it("marks a failed universe read rather than returning a bare empty list", () => {
    expect(SCOUT.includes("failed: true")).toBe(true);
    expect(SCOUT.includes("universeFailed")).toBe(true);
  });

  it("files an infrastructure failure as cron, not as a data finding", () => {
    // Reporting a Gateway Timeout as "no evidence" sent the reader to look at a
    // screener that was never empty.
    expect(SCOUT.includes('category: universeFailed ? "cron" : "data"')).toBe(true);
    expect(SCOUT.includes("could not read its universe")).toBe(true);
  });

  it("puts the universe source in the alert detail", () => {
    // It was computed and then dropped, which is why diagnosing this needed a
    // database query rather than reading the alert.
    expect(SCOUT.includes("source=${source}")).toBe(true);
  });

  it("retries the universe read before concluding anything", () => {
    expect(SCOUT.includes("withSupabaseRetry")).toBe(true);
  });
});

describe("every job that died to a Gateway Timeout now retries it", () => {
  // All four open failures on 2026-09-14 had the same cause, which is why the
  // predicate and backoff live in one shared module rather than four copies:
  //   EdgeIC          "edge market status failed (us/signed_adx_14): Gateway Timeout"
  //   EdgeScout       "Universe=0"  (same timeout, swallowed)
  //   Edge readiness  "edge readiness status write failed: Gateway Timeout"
  //   Validation sweep "us: Gateway Timeout"
  it("all four import the one shared helper", () => {
    for (const [name, src] of Object.entries({ IC, SCOUT, READINESS, SWEEP })) {
      expect(src.includes("withSupabaseRetry"), `${name} does not retry`).toBe(true);
      expect(src.includes('from "@/lib/supabase/transient"'), `${name} uses its own copy`).toBe(true);
    }
  });

  it("the readiness write it retries is the keyed, idempotent one", () => {
    expect(READINESS.includes('onConflict: "edge_id,market,horizon"')).toBe(true);
  });

  it("the sweep retries a read, which is free to repeat", () => {
    expect(SWEEP.includes('svc.from("strategy_versions")')).toBe(true);
    // The sweep runs WEEKLY (45 21 * * 5), so one unretried hiccup leaves a
    // failure alert standing for seven days until the next Friday.
    expect(SWEEP.includes("resolveIssue(HEALTH_KEY)")).toBe(true);
  });

  it("nobody re-inlines a transient predicate instead of sharing this one", () => {
    for (const [name, src] of Object.entries({ IC, SCOUT, READINESS, SWEEP })) {
      expect(/retryIf:\s*\(message\)\s*=>/.test(src), `${name} inlines its own predicate`).toBe(false);
    }
  });
});
