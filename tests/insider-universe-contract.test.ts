import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { symbolsFromLatestLiveSnapshots } from "@/lib/research/holding-symbols";

const ROUTE = resolve(__dirname, "../app/api/markets/edgar-insiders/route.ts");

// Strip comments before matching. The fix documents the old broken calls by
// name in its comments, so a raw text scan would match the explanation of the
// bug and fail on the very code that fixed it.
const source = () =>
  readFileSync(ROUTE, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

// The insider symbol universe was half-dead in two ways at once. Both are
// invisible at runtime (supabase-js reports errors in `error`, not by throwing),
// so these are pinned statically + via the shared union helper.

describe("edgar-insiders universe — phantom table", () => {
  it("does not query agent_watchlist, which does not exist in prod", () => {
    // Verified against prod information_schema (2026-07-16): only `watchlist`
    // exists. `(watchlist ?? [])` swallowed the error, so half the universe
    // silently vanished.
    expect(source()).not.toContain("agent_watchlist");
  });

  it("queries the real watchlist table", () => {
    expect(source()).toMatch(/from\("watchlist"\)/);
  });

  it("does not filter watchlist on is_active, a column it does not have", () => {
    // `watchlist` uses expires_at, not is_active — a bare table rename would
    // have kept this broken while looking fixed.
    expect(source()).not.toMatch(/is_active/);
    expect(source()).toMatch(/expires_at/);
  });
});

describe("edgar-insiders universe — account selection", () => {
  it("does not collapse seven broker accounts to one arbitrary snapshot", () => {
    // `.limit(1).single()` ordered by captured_at picked ONE of seven accounts,
    // decided by a ~294ms capture tiebreak (Webull won), so the Agentic and
    // Trading accounts contributed nothing.
    expect(source()).not.toMatch(/\.limit\(1\)\s*\n?\s*\.single\(\)/);
  });

  it("unions every account's latest snapshot via the shared helper", () => {
    expect(source()).toContain("symbolsFromLatestLiveSnapshots");
  });

  it("surfaces a failed universe read instead of returning an empty market", () => {
    expect(source()).toMatch(/snapshots\.error/);
    expect(source()).toMatch(/watchlist\.error/);
  });
});

describe("symbolsFromLatestLiveSnapshots — the union this route now relies on", () => {
  it("includes holdings from every account, not just the newest-captured one", () => {
    // Mirrors the real prod batch: all seven captured within the same second.
    const rows = [
      { broker: "webull", account_id: "LUJ2IQBT", captured_at: "2026-07-16T21:00:04.355Z", positions_json: [{ symbol: "WBD", qty: 1 }] },
      { broker: "robinhood", account_id: "605420660", captured_at: "2026-07-16T21:00:04.061Z", positions_json: [{ symbol: "AGENTIC", qty: 1 }] },
      { broker: "robinhood", account_id: "965848641", captured_at: "2026-07-16T21:00:04.061Z", positions_json: [{ symbol: "TRADING", qty: 1 }] },
    ];
    // The old code would have yielded only WBD (Webull, newest by 294ms).
    expect(symbolsFromLatestLiveSnapshots(rows)).toEqual(["AGENTIC", "TRADING", "WBD"]);
  });
});
