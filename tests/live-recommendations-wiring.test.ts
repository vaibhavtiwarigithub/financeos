import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Pins the guarantees that keep the tracker display-only: owner-only read route, append-only tables, no write path to orders or stops,
// and a client panel with no server-only imports.
const job = readFileSync("app/api/agents/live-recommendations/route.ts", "utf8");
const read = readFileSync("app/api/live-portfolio/recommendations/route.ts", "utf8");
const panel = readFileSync("components/dashboard/RecommendationsPanel.tsx", "utf8");
const migration = readFileSync("supabase/migrations/20261014162931_live_recommendation_tracker.sql", "utf8");

describe("live recommendation tracker wiring", () => {
  it("surfaces explicit sell/reduce ideas separately from the buy-heavy timeline", () => {
    const panel = readFileSync("components/dashboard/RecommendationsPanel.tsx", "utf8");
    expect(panel).toContain("Sell / reduce ideas and downside follow-up");
    expect(panel).toContain("r.kind !== \"buy_idea\"");
    expect(panel).toContain("hypothetical value difference versus holding it");
    expect(panel).toContain("not actual realized P/L");
    expect(panel).toContain("qty_suggested");
  });

  it("never touches orders, stops or Guardian settings", () => {
    for (const forbidden of ["place_order", "submitOrder", "robinhood"]) expect(job).not.toContain(forbidden);
    const store = readFileSync("lib/live-recommendations/guardian-store.ts", "utf8");
    expect(store).not.toMatch(/from\("(?:broker_orders|guardian_protection_plans)"\)\s*\.(?:insert|upsert|update|delete)/);
    expect(job).toContain("behavior changed=false");
  });
  it("only inserts into its own three tables", () => {
    const written = [...job.matchAll(/from\("([a-z_]+)"\)\s*\.(?:upsert|insert)/g)].map((m) => m[1]);
    expect(new Set(written)).toEqual(new Set(["live_recommendations", "live_recommendation_marks", "live_guardian_revisions", "agent_runs"]));
  });
  it("read route is owner only", () => {
    expect(read).toContain("requireOwner");
    expect(read).not.toContain("requireViewerOrOwner");
  });
  it("tables are append-only with RLS and no client grants", () => {
    for (const t of ["live_recommendations", "live_recommendation_marks", "live_guardian_revisions"]) {
      expect(migration).toContain(`alter table public.${t} enable row level security`);
      expect(migration).toContain(`${t}_no_change`);
    }
    expect(migration).toContain("revoke all on public.live_recommendations");
  });
  it("keeps the client panel free of server-only imports", () => {
    const imports = [...panel.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports.every((i) => ["react", "@/types", "./GuardianOutcomeScorecard", "@/lib/live-recommendations/display"].includes(i))).toBe(true);
  });
  it("uses one market-scoped, owner-only exact-stop display in both pipelines", () => {
    const indiaRead = readFileSync("app/api/live-portfolio/india-recommendations/route.ts", "utf8");
    const indiaPanel = readFileSync("components/dashboard/IndiaLiveGuardianPanels.tsx", "utf8");
    expect(read).toContain('loadGuardianOutcomeScorecard(svc, "us")');
    expect(indiaRead).toContain('loadGuardianOutcomeScorecard(svc, "india")');
    expect(indiaRead).toContain("requireOwner");
    for (const source of [read, indiaRead]) expect(source).toContain('"private, no-store"');
    for (const source of [panel, indiaPanel]) expect(source).toContain("<GuardianOutcomeScorecard");
    expect(panel).toContain("unrealized estimate");
  });
  it("freezes new advice without granting client access or fabricating history", () => {
    const extension = readFileSync("supabase/migrations/20261022214835_guardian_exact_stop_outcomes.sql", "utf8");
    expect(extension).toContain("security invoker set search_path=public,pg_temp");
    expect(extension).toContain("from public,anon,authenticated");
    expect(extension).not.toMatch(/disable row level security|disable trigger|security definer|update public.live_recommendations/i);
    expect(extension).toContain("One advice record, not a duplicate");
    expect(extension).toContain("No historical backfill");
    expect(job).toContain("row.unavailable > 0");
    expect(job).toContain('market: "india"');
  });
});
