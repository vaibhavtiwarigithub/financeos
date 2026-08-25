import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Pins the ?market= contract of the read routes that the global market switcher
// drives. The bug these guard against: the routes took no market param at all,
// so the switcher physically could not reach them and US/India rows were listed
// interleaved (two indistinguishable CHAMPION rows, ₹ proposals under $ ones).
//
// The subtle half is null-tolerance. Verified against the live DB:
//   learner_runs.market      NOT NULL DEFAULT 'us'  -> plain .eq() is complete
//   strategy_versions.market NOT NULL DEFAULT 'us'  -> plain .eq() is complete
//   trade_proposals.market   NULLABLE (live NULL rows) -> "us" MUST also match NULL
// A plain .eq("market","us") on trade_proposals silently hides pre-backfill
// proposals from review, which is why the .or() below is asserted explicitly.

const h = vi.hoisted(() => ({ from: vi.fn(), calls: [] as any[] }));

vi.mock("@/lib/auth/require-owner", () => ({ requireOwner: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({ from: h.from }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "owner" } } }) } }),
}));

// Chainable query-builder stub that records every filter applied.
function builder(rows: any[]) {
  const record: any = { eq: [], or: [], in: [] };
  const b: any = {
    select: () => b,
    order: () => b,
    limit: () => Promise.resolve({ data: rows, error: null }),
    in: (col: string, v: any) => { record.in.push([col, v]); return b; },
    eq: (col: string, v: any) => { record.eq.push([col, v]); return b; },
    or: (expr: string) => { record.or.push(expr); return b; },
    then: (res: any) => Promise.resolve({ data: rows, error: null }).then(res),
  };
  h.calls.push(record);
  return b;
}

import { GET as learnerBrainGET } from "@/app/api/agents/learner-brain/route";
import { GET as traderGET } from "@/app/api/agents/trader/route";

function req(url: string) { return new NextRequest(url); }

beforeEach(() => { h.from.mockReset(); h.calls.length = 0; });

describe("learner-brain read is market-scoped", () => {
  it("filters to the requested market", async () => {
    h.from.mockImplementation(() => builder([]));
    const res = await learnerBrainGET(req("http://localhost/api/agents/learner-brain?market=india"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ market: "india" });
    expect(h.calls[0].eq).toContainEqual(["market", "india"]);
  });

  it("defaults to us when ?market= is absent (back-compat for existing callers)", async () => {
    h.from.mockImplementation(() => builder([]));
    const res = await learnerBrainGET(req("http://localhost/api/agents/learner-brain"));
    expect(await res.json()).toMatchObject({ market: "us" });
    expect(h.calls[0].eq).toContainEqual(["market", "us"]);
  });

  it("treats an unknown market as us rather than passing it through to the DB", async () => {
    h.from.mockImplementation(() => builder([]));
    await learnerBrainGET(req("http://localhost/api/agents/learner-brain?market=' OR 1=1--"));
    expect(h.calls[0].eq).toContainEqual(["market", "us"]);
  });
});

describe("trader proposal listing is market-scoped and null-tolerant", () => {
  it("uses a plain equality filter for india", async () => {
    h.from.mockImplementation(() => builder([]));
    const res = await traderGET(req("http://localhost/api/agents/trader?market=india"));
    expect(res.status).toBe(200);
    expect(h.calls[0].eq).toContainEqual(["market", "india"]);
    // India must not get the us NULL-tolerant market fallback. Asserted against
    // the market filter specifically, not "no .or() at all" — the query also
    // carries an unrelated .or() excluding shadow proposals, and a bare length
    // check would silently conflate the two.
    expect(h.calls[0].or).not.toContainEqual("market.eq.us,market.is.null");
    expect(h.calls[0].or.filter((f: string) => f.includes("market."))).toHaveLength(0);
  });

  it("matches NULL market rows under us, so pre-backfill proposals stay reviewable", async () => {
    h.from.mockImplementation(() => builder([]));
    await traderGET(req("http://localhost/api/agents/trader?market=us"));
    expect(h.calls[0].or).toContainEqual("market.eq.us,market.is.null");
    expect(h.calls[0].eq).not.toContainEqual(["market", "us"]);
  });

  it("still only lists reviewable statuses (read path unchanged)", async () => {
    h.from.mockImplementation(() => builder([]));
    await traderGET(req("http://localhost/api/agents/trader"));
    expect(h.calls[0].in).toContainEqual(["status", ["pending_review", "approved", "submitted"]]);
  });
});
