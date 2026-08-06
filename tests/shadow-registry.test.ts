import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SHADOW_PROGRAMS } from "@/lib/shadows/registry";

describe("shadow registry governance contract", () => {
  const migration = readFileSync("supabase/migrations/20260729210000_shadow_registry_cron_status.sql", "utf8");
  const route = readFileSync("app/api/upgrade-path/route.ts", "utf8");
  const optionsRoute = readFileSync("app/api/options/signal/route.ts", "utf8");
  const optionsSource = readFileSync("lib/options-signal.ts", "utf8");
  const research = readFileSync("lib/research-agent.ts", "utf8");
  const shell = readFileSync("components/dashboard/DashboardShell.tsx", "utf8");
  const upgradePage = readFileSync("components/dashboard/UpgradePathPage.tsx", "utf8");
  const statusAdapter = readFileSync("lib/shadows/status.ts", "utf8");

  it("uses stable unique IDs and complete descriptive boundaries", () => {
    const ids = SHADOW_PROGRAMS.map((program) => program.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(SHADOW_PROGRAMS.length).toBeGreaterThanOrEqual(10);
    for (const program of SHADOW_PROGRAMS) {
      expect(program.purpose.length).toBeGreaterThan(20);
      expect(program.productBenefit.length).toBeGreaterThan(20);
      expect(program.traderBenefit.length).toBeGreaterThan(20);
      expect(program.activationGate.length).toBeGreaterThan(20);
      expect(program.safetyBoundary.length).toBeGreaterThan(20);
      expect(program.evidenceSource.length).toBeGreaterThan(3);
    }
  });

  it("registers the outstanding feature-pack gates rather than hiding them in docs", () => {
    const ids = new Set(SHADOW_PROGRAMS.map((program) => program.id));
    expect(ids.has("technical-calibration")).toBe(true);
    expect(ids.has("dimension-diagnostics")).toBe(true);
    expect(ids.has("pit-fundamental-qualification")).toBe(true);
    expect(ids.has("specialist-feature-packs")).toBe(true);
  });

  it("maps every known shadow and evidence cron to a registry program", () => {
    const jobs = new Set(SHADOW_PROGRAMS.flatMap((program) => program.cronJobs));
    [
      "kairos-evidence-shadow-us",
      "kairos-evidence-shadow-india",
      "kairos-evidence-cohort-us",
      "kairos-evidence-cohort-india",
      "kairos-edge-scout-us",
      "kairos-edge-scout-india",
      "kairos-edge-ic-us",
      "kairos-edge-ic-india",
      "kairos-earnings-pit-capture",
      "kairos-international-allocation-shadow",
      "kairos-shadow-us",
      "kairos-shadow-india",
      "kairos-validation-sweep",
      "kairos-downside-hedge-us",
      "kairos-dimension-diagnostics-us",
      "kairos-dimension-diagnostics-india",
    ].forEach((job) => expect(jobs.has(job), `${job} is not registered`).toBe(true));
  });

  it("keeps schedule truth service-only and removes only the idle autonomous campaign", () => {
    expect(migration).toContain("security definer");
    expect(migration).toContain("set search_path = public, cron");
    expect(migration).toContain("from public, anon, authenticated");
    expect(migration).toContain("to service_role");
    expect(migration).toContain("cron.unschedule('kairos-shadow-us')");
    expect(migration).toContain("cron.unschedule('kairos-shadow-india')");
    expect(migration).not.toContain("cron.unschedule('kairos-evidence-shadow");
  });

  it("owner-gates the read model and options inspection endpoint", () => {
    expect(route).toContain("requireOwner()");
    expect(route).toContain('market !== "us" && market !== "india"');
    expect(route).toContain("getShadowProgramStatuses(svc, market)");
    expect(optionsRoute).toContain("requireOwner()");
    expect(optionsRoute).toContain("invalid symbol");
    expect(optionsSource).toContain("encodeURIComponent(canonicalSymbol)");
  });

  it("keeps options outside ResearchAgent scoring and prompts", () => {
    expect(research).toContain("_options_signal: null");
    expect(research).not.toContain("Pre-fetched options flow");
    expect(research).not.toContain("institutional bullish bet");
    expect(research).not.toContain("Options flow (nearest expiry");
  });

  it("does not server-render a timezone-dependent dashboard clock", () => {
    expect(shell).toContain("localDate: clock.localDate");
    expect(shell).toContain("<span>{localDate}</span>");
    expect(shell).not.toContain("<span>{new Date().toLocaleDateString");
  });

  it("uses the shared market switch and scopes evidence before aggregation", () => {
    expect(upgradePage).toContain("const { market } = useMarket()");
    expect(upgradePage).toContain("/api/upgrade-path?market=${market}");
    expect(upgradePage).not.toContain("Filter by market");
    expect(upgradePage).not.toContain("<option value=\"all\">All markets");
    expect(statusAdapter).toContain('export async function getShadowProgramStatuses(svc: any, market: ShadowMarket)');
    expect(statusAdapter).toContain('.eq("market", market)');
    expect(statusAdapter).toContain('status.lifecycle = "not_applicable"');
    expect(statusAdapter).toContain('progress(sessions.size, 10, "market-session proofs", 45)');
  });
});
