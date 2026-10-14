import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Pins the guarantees that keep the tracker display-only: owner-only read route, append-only tables, no write path to orders or stops,
// and a client panel with no server-only imports.
const job = readFileSync("app/api/agents/live-recommendations/route.ts", "utf8");
const read = readFileSync("app/api/live-portfolio/recommendations/route.ts", "utf8");
const panel = readFileSync("components/dashboard/RecommendationsPanel.tsx", "utf8");
const migration = readFileSync("supabase/migrations/20261014162931_live_recommendation_tracker.sql", "utf8");

describe("live recommendation tracker wiring", () => {
  it("never touches orders, stops or Guardian settings", () => {
    for (const forbidden of ["broker_orders", "guardian_protection_plans", "place_order", "submitOrder", "robinhood"]) expect(job).not.toContain(forbidden);
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
    expect(imports.every((i) => ["react"].includes(i))).toBe(true);
  });
});
