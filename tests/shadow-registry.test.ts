import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SHADOW_PROGRAMS } from "@/lib/shadows/registry";
import { routerReadiness, type RouterEvaluationRow } from "@/lib/shadows/status";

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
    expect(SHADOW_PROGRAMS.length).toBeGreaterThanOrEqual(21);
    for (const program of SHADOW_PROGRAMS) {
      expect(program.purpose.length).toBeGreaterThan(20);
      expect(program.productBenefit.length).toBeGreaterThan(20);
      expect(program.traderBenefit.length).toBeGreaterThan(20);
      expect(program.activationGate.length).toBeGreaterThan(20);
      expect(program.safetyBoundary.length).toBeGreaterThan(20);
      expect(program.evidenceSource.length).toBeGreaterThan(3);
      expect(program.mainline.enteredAt).toMatch(/^20\d{2}-\d{2}-\d{2}$/);
      expect(program.mainline.commit).toMatch(/^[0-9a-f]{8}$/);
      expect(program.mainline.reason.length).toBeGreaterThan(30);
    }
  });

  it("registers the outstanding feature-pack gates rather than hiding them in docs", () => {
    const ids = new Set(SHADOW_PROGRAMS.map((program) => program.id));
    expect(ids.has("technical-calibration")).toBe(true);
    expect(ids.has("dimension-diagnostics")).toBe(true);
    expect(ids.has("pit-fundamental-qualification")).toBe(true);
    expect(ids.has("specialist-feature-packs")).toBe(true);
    expect(ids.has("horizon-extension")).toBe(true);
    expect(ids.has("exit-stop-shadow")).toBe(true);
    expect(ids.has("archetype-ic")).toBe(true);
    expect(ids.has("alpha-diagnostics")).toBe(true);
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
      "kairos-horizon-extension-shadow-us",
      "kairos-horizon-extension-shadow-india",
      "kairos-exit-stop-shadow-us",
      "kairos-exit-stop-shadow-india",
      "kairos-archetype-ic-us",
      "kairos-archetype-ic-india",
      "kairos-alpha-diagnostics-us",
      "kairos-alpha-diagnostics-india",
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
    expect(statusAdapter).toContain('progress(passingSessions.size, 10, "passing market-session proofs for one exact tuple", 45)');
  });

  it("separates mainline provenance from live production influence", () => {
    expect(route).toContain("VERCEL_GIT_COMMIT_SHA");
    expect(upgradePage).toContain("Mainline and production");
    expect(upgradePage).toContain("Why not next stage");
    expect(upgradePage).toContain("program.mainline.enteredAt");
    expect(upgradePage).toContain("program.deployment.summary");
    expect(upgradePage).toContain("requestSequence.current");
    expect(upgradePage).toContain("next.market !== market");
    expect(upgradePage).toContain("market={data?.market ?? market}");
    expect(statusAdapter).toContain("production_measurement");
    expect(statusAdapter).toContain("production_blocked");
    expect(statusAdapter).toContain("scheduled_idle");
  });

  it("reports the setup-expert idempotency conflict instead of calling India merely idle", () => {
    expect(statusAdapter).toContain("Missing always-on setup evidence");
    expect(statusAdapter).toContain("only one NULL-policy setup row per observation");
    expect(statusAdapter).toContain("(observation, setup_type) uniqueness");
  });

  it("does not declare Router readiness from one pass or treat zero degradation events as a dead job", () => {
    expect(statusAdapter).toContain("routerGate.selectedFresh && routerGate.selectedPasses && passingSessions.size >= 10");
    expect(statusAdapter).toContain('degradation.length || evaluationRuns ? "collecting" : "idle"');
  });

  it("mirrors the Router activation tuple and historical-proof TTL semantics", () => {
    const base: RouterEvaluationRow = {
      market: "india", passed: true, safety_pass: true, quality_pass: true,
      created_at: "2026-09-03T05:00:00Z", expires_at: "2026-09-06T05:00:00Z",
      market_session_date: "2026-09-03", candidate_version_id: "candidate-a",
      baseline_version_id: "baseline-a", evaluation_code_version: "eval-v2", strategy_version: "v1.0",
    };
    const historical = Array.from({ length: 9 }, (_, index) => ({
      ...base,
      created_at: `2026-08-${String(25 - index).padStart(2, "0")}T05:00:00Z`,
      expires_at: "2026-08-28T05:00:00Z", // expired now, but valid rolling proof
      market_session_date: `2026-08-${String(25 - index).padStart(2, "0")}`,
    }));
    const wrongTuple = { ...base, candidate_version_id: "candidate-b", created_at: "2026-08-10T05:00:00Z", market_session_date: "2026-08-10" };
    const result = routerReadiness([wrongTuple, ...historical, base], new Date("2026-09-03T12:00:00Z"));
    expect(result.selectedFresh).toBe(true);
    expect(result.selectedPasses).toBe(true);
    expect(result.passingSessions.size).toBe(10);
    expect(result.passingSessions.has("2026-08-10")).toBe(false);
  });

  it("paginates label coverage instead of trusting PostgREST's per-request row cap", () => {
    expect(statusAdapter).toContain("loadLabelCoverageRows(svc, market)");
    expect(statusAdapter).toContain('.range(from, from + pageSize - 1)');
    expect(statusAdapter).toContain("Label coverage exceeds the bounded");
  });
});
