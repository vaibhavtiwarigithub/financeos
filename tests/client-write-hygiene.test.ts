import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// THE DEFECT THIS GUARDS.
//
// AgentsPage's "Kill Switch" button — documented on that page as "disables live
// trading immediately — use if agent behavior looks wrong" — wrote
// strategy_config through the BROWSER supabase client:
//
//   await supabase.from("strategy_config").update({ trading_enabled: next })...
//   setTradingEnabled(next);   // flipped the label regardless
//
// RLS grants `authenticated` SELECT only on strategy_config; writes are
// service_role. The update was silently rejected, the returned error was never
// read, and the optimistic state flip made the UI show the kill switch as
// ENGAGED while live trading stayed on. saveStrategyConfig had the same shape
// and showed "Saved!" unconditionally.
//
// A safety control that reports success without acting is worse than no control.
// The fix routes both through owner-gated API routes. This test stops the shape
// from coming back anywhere in the client bundle.
//
// Verified against production RLS on 2026-09-09: none of the tables below grant
// INSERT/UPDATE/DELETE to `authenticated`.
const SERVICE_ROLE_ONLY_TABLES = [
  "strategy_config",
  "market_controls",
  "paper_positions",
  "trade_proposals",
  "broker_orders",
  "broker_accounts",
];

const MUTATIONS = ["update", "insert", "delete", "upsert"];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const roots = ["components", "app"].map(d => join(process.cwd(), d));
const clientFiles = roots
  .flatMap(r => walk(r))
  .map(path => ({ path, src: readFileSync(path, "utf8") }))
  // Only browser-executed modules can be constrained by RLS as `authenticated`.
  // Server routes legitimately use the service client.
  .filter(f => /^\s*["']use client["']/m.test(f.src));

describe("client components never write service-role-only tables", () => {
  it("finds client components to check (guards against a silently empty scan)", () => {
    expect(clientFiles.length).toBeGreaterThan(5);
  });

  for (const table of SERVICE_ROLE_ONLY_TABLES) {
    it(`no browser-side mutation of ${table}`, () => {
      const offenders: string[] = [];
      for (const { path, src } of clientFiles) {
        for (const op of MUTATIONS) {
          // .from("table") ... .op(   — allow whitespace/chaining between them,
          // but stop at a newline-heavy gap so we don't match across functions.
          const re = new RegExp(`\\.from\\(\\s*["'\`]${table}["'\`]\\s*\\)[^;]{0,200}?\\.${op}\\s*\\(`, "s");
          if (re.test(src)) offenders.push(`${path.replace(process.cwd(), "")} -> .${op}()`);
        }
      }
      expect(
        offenders,
        `Browser-side write to ${table}, which RLS grants 'authenticated' read-only. ` +
        `The write will be silently rejected and the UI will report success. ` +
        `Route it through an owner-gated API instead:\n${offenders.join("\n")}`,
      ).toEqual([]);
    });
  }
});

describe("AgentsPage specifically", () => {
  const src = readFileSync(join(process.cwd(), "components/dashboard/AgentsPage.tsx"), "utf8");

  it("holds no browser supabase client at all", () => {
    expect(src).not.toMatch(/createClient\(\)/);
    expect(src).not.toMatch(/@\/lib\/supabase\/client/);
  });

  it("the kill switch flips local state only after the server confirms", () => {
    const fn = src.slice(src.indexOf("async function toggleTrading"));
    const body = fn.slice(0, fn.indexOf("\n  }"));
    // setTradingEnabled must not be reachable before an r.ok check.
    expect(body).toMatch(/if\s*\(!r\.ok\)/);
    expect(body.indexOf("r.ok")).toBeLessThan(body.indexOf("setTradingEnabled(next)"));
  });

  it("no longer offers the two settings nothing reads", () => {
    // max_position_pct is read by no code path; min_analyst_score is selected in
    // research-agent but never used (only risk_profile is read off that row).
    // Match the control definition, not any mention — the explanatory comment
    // left in its place names the removed labels on purpose.
    expect(src).not.toMatch(/label:\s*["']Min score to trade["']/);
    expect(src).not.toMatch(/label:\s*["']Max position %["']/);
    expect(src).not.toMatch(/setMinScore|setMaxPos\b/);
  });
});
