import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression: /api/markets/insider-trades fetched the House Stock Watcher S3
// dataset inside `try { ... } catch { /* silently skip */ }`. That bucket went
// private (us-east-2 -> 301 PermanentRedirect, us-west-2 -> 403 AccessDenied,
// verified live 2026-07-16) and the project is unmaintained. So the route
// returned `{ trades: [] }` on every request and the panel rendered "No recent
// congressional trades found." — i.e. a DEAD SOURCE was displayed as GOOD NEWS,
// with nothing logged and no alert. Same bug class as fetchHoldings' old
// `catch { return [] }`.
//
// These tests pin the contract:
//   * a dead upstream is LOUD (System Health issue), never a silent empty array
//   * "unavailable" is distinguishable from "no trades to show"
//   * a permanently-gone source is not re-fetched and offers no fake retry
//   * India renders the structural not-supported state

const reportIssue = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/system-health", () => ({
  reportIssue: (...args: unknown[]) => reportIssue(...args),
  resolveIssue: vi.fn(),
}));

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("congress feed fails loud and honest (never silently empty)", () => {
  beforeEach(() => {
    reportIssue.mockClear();
    vi.resetModules();
  });

  it("raises a System Health issue instead of swallowing the dead upstream", async () => {
    const { GET } = await import("@/app/api/markets/insider-trades/route");
    await GET();

    expect(reportIssue).toHaveBeenCalledTimes(1);
    const issue = reportIssue.mock.calls[0][0] as Record<string, string>;
    expect(issue.issueKey).toBe("markets-congress-source:discontinued");
    expect(issue.severity).toBe("warn");
    expect(issue.category).toBe("market-data");
    // The alert must carry why, not just that.
    expect(issue.detail).toMatch(/403|AccessDenied/);
    expect(issue.detail).toMatch(/house-stock-watcher/i);
  });

  it("returns an explicit unavailable state, not a bare empty list", async () => {
    const { GET } = await import("@/app/api/markets/insider-trades/route");
    const body = await (await GET()).json();

    // The old shape was exactly `{ trades: [] }` — indistinguishable from
    // "the feed worked and nobody traded". That must no longer be all we say.
    expect(body.status).toBe("discontinued");
    expect(Object.keys(body)).not.toEqual(["trades"]);
    expect(body.trades).toEqual([]);
  });

  it("marks the condition permanent so the UI cannot offer a fake retry", async () => {
    const { GET } = await import("@/app/api/markets/insider-trades/route");
    const body = await (await GET()).json();

    expect(body.retryable).toBe(false);
    expect(body.reason).toMatch(/discontinued/i);
  });

  it("explains what happened, why, and what comes next", async () => {
    const { GET } = await import("@/app/api/markets/insider-trades/route");
    const body = await (await GET()).json();

    expect(body.source).toMatch(/house-stock-watcher/i);
    expect(body.detail).toMatch(/403|AccessDenied/);       // what
    expect(body.detail).toMatch(/discontinued|private|unmaintained/i); // why
    expect(body.detail).toMatch(/Next:/);                   // next
  });

  it("does not re-fetch the source it knows is permanently gone", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { GET } = await import("@/app/api/markets/insider-trades/route");
    await GET();

    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("does not re-report the same issue on every page load", async () => {
    const { GET } = await import("@/app/api/markets/insider-trades/route");
    await GET();
    await GET();
    await GET();

    // Deduped by issue_key anyway; the throttle keeps a display route from
    // hammering the alerts table on every render.
    expect(reportIssue).toHaveBeenCalledTimes(1);
  });

  it("no longer contains the silent catch", () => {
    const route = source("app/api/markets/insider-trades/route.ts");
    expect(route).not.toContain("silently skip");
    // The dead endpoint must not be reachable from code any more.
    expect(route).not.toMatch(/await fetch\(\s*"https:\/\/house-stock-watcher-data/);
  });
});

describe("Smart Money UI distinguishes unavailable from empty", () => {
  const markets = () => source("components/dashboard/MarketsPage.tsx");

  /** Source of the SmartMoneyTrades component, up to the next top-level function. */
  function smartMoneyBody(): string {
    const src = markets();
    const start = src.indexOf("function SmartMoneyTrades()");
    expect(start).toBeGreaterThan(-1);
    const rest = src.slice(start);
    return rest.slice(0, rest.indexOf("\nfunction ", 1));
  }

  it("drops the silent catch on the smart-money fetch", () => {
    // `.catch(() => {})` blanked the whole panel on any fetch error.
    // (SentimentPairs still has one — different feature, tracked separately.)
    expect(smartMoneyBody()).not.toContain(".catch(() => {})");
    expect(smartMoneyBody()).toContain("Promise.allSettled");
  });

  it("renders the discontinued state with no retry control", () => {
    const src = markets();
    expect(src).toContain("function DiscontinuedNote");
    expect(src).toContain('tabState.kind === "discontinued"');
    // DiscontinuedNote must not take/render an onRetry — permanence is the point.
    const note = src.slice(src.indexOf("function DiscontinuedNote"));
    expect(note.slice(0, note.indexOf("function snapRowToQuote"))).not.toContain("onRetry");
  });

  it("keeps 'no trades found' for the genuinely-empty case only", () => {
    const src = markets();
    expect(src).toContain('tabState.kind === "ok" && visible.length === 0');
    expect(src).toContain("No recent {tab === \"insider\" ? \"insider\" : \"congressional\"} trades found.");
  });

  it("surfaces a read failure instead of swallowing it", () => {
    expect(markets()).toContain('tabState.kind === "failed"');
  });
});

describe("India renders the structural not-supported state for smart money", () => {
  it("declares congressional data US-only rather than omitting the panel", () => {
    const src = source("components/dashboard/MarketsPage.tsx");
    expect(src).toContain('<NotSupportedNote label="Congressional (US House) trade disclosures" />');
  });

  it("does not overclaim the gap: India insider/flow analogs exist and are not called unsupported", () => {
    // India has SEBI PIT insider disclosures (`fetchNseInsider`) and FII/DII flows
    // (/api/india/smart-money). They are unwired, not absent. Declaring them
    // "not supported" would be the same class of lie as the silent empty box.
    const src = source("components/dashboard/MarketsPage.tsx");
    expect(src).not.toMatch(/<NotSupportedNote label="[^"]*Form 4[^"]*"/);
    expect(src).not.toMatch(/<NotSupportedNote label="[^"]*FII\/DII[^"]*"/);
  });

  it("does not offer India a retry for a structural gap", () => {
    const src = source("components/dashboard/MarketsPage.tsx");
    const note = src.slice(src.indexOf("function NotSupportedNote"));
    expect(note.slice(0, note.indexOf("function DiscontinuedNote"))).not.toContain("onRetry");
  });
});
