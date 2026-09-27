import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SHADOW_PROGRAMS } from "@/lib/shadows/registry";
import { routerReadiness, type RouterEvaluationRow } from "@/lib/shadows/status";

describe("shadow registry governance contract", () => {
  const migration = readFileSync("supabase/migrations/20260729210000_shadow_registry_cron_status.sql", "utf8");
  const route = readFileSync("app/api/upgrade-path/route.ts", "utf8");
  const bookLedger = readFileSync("lib/shadows/shadow-book-ledger.ts", "utf8");
  const optionsRoute = readFileSync("app/api/options/signal/route.ts", "utf8");
  const optionsSource = readFileSync("lib/options-signal.ts", "utf8");
  const research = readFileSync("lib/research-agent.ts", "utf8");
  const shell = readFileSync("components/dashboard/DashboardShell.tsx", "utf8");
  const upgradePage = readFileSync("components/dashboard/UpgradePathPage.tsx", "utf8");
  const statusAdapter = readFileSync("lib/shadows/status.ts", "utf8");
  const retiredHorizonCronMigration = readFileSync("supabase/migrations/20260927202139_retire_horizon_extension_shadow_jobs.sql", "utf8");

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
      expect(["matched_replay", "paper_cohort", "operational_only"]).toContain(program.attributionClass);
    }
  });

  it("requires exact blocker text for every performance-eligible path without a verified producer", () => {
    const missingProducer = SHADOW_PROGRAMS.filter((program) =>
      program.id !== "international-allocation" && program.attributionClass !== "operational_only");
    expect(missingProducer.length).toBeGreaterThan(0);
    for (const program of missingProducer) {
      expect(program.attributionBlocker, program.id).toBeTruthy();
      expect(program.attributionBlocker!.length, program.id).toBeGreaterThan(120);
    }
    for (const id of ["score-price-divergence", "live-exit-ladder-parity", "archetype-ic", "technical-calibration", "specialist-feature-packs", "earnings-risk", "autonomous-live"]) {
      expect(SHADOW_PROGRAMS.find((program) => program.id === id)?.attributionClass).toBe("operational_only");
    }
  });

  it("binds time-review liveness to the real market-local PositionMonitor and retires the obsolete comparator jobs", () => {
    const program = SHADOW_PROGRAMS.find((candidate) => candidate.id === "horizon-extension")!;
    expect(program.marketCronJobs).toEqual({
      us: ["kairos-position-monitor"],
      india: ["kairos-position-monitor-india"],
    });
    expect(retiredHorizonCronMigration).toContain("cron.unschedule(v_job_id)");
    expect(retiredHorizonCronMigration).toContain("kairos-horizon-extension-shadow-us");
    expect(retiredHorizonCronMigration).toContain("kairos-horizon-extension-shadow-india");
  });

  it("binds setup-expert evidence to the market-local ResearchAgent schedules", () => {
    const program = SHADOW_PROGRAMS.find((candidate) => candidate.id === "setup-experts")!;
    expect(program.marketCronJobs).toEqual({
      us: ["kairos-research"],
      india: ["kairos-research-india"],
    });
    expect(program.cronJobs).toEqual(["kairos-research", "kairos-research-india"]);
  });

  it("keeps forward descriptive P&L snapshots separate from causal attribution and market-local", () => {
    expect(route).toContain('svc.rpc("get_upgrade_path_shadow_book_latest", { p_market: market })');
    expect(route).toContain('row.market !== market');
    expect(upgradePage).toContain("Forward shadow-book P&L · descriptive, not promotion proof");
    expect(bookLedger).toContain("Daily P&L is descriptive only");
    expect(upgradePage).toContain("Causal attribution");
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
    expect(ids.has("score-price-divergence")).toBe(true);
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
      "kairos-position-monitor",
      "kairos-position-monitor-india",
      "kairos-exit-stop-shadow-us",
      "kairos-exit-stop-shadow-india",
      "kairos-archetype-ic-us",
      "kairos-archetype-ic-india",
      "kairos-alpha-diagnostics-us",
      "kairos-alpha-diagnostics-india",
      "kairos-score-price-divergence-us",
      "kairos-score-price-divergence-india",
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
    expect(statusAdapter).toContain("upgrade_path_attribution_runs");
    expect(upgradePage).toContain("Causal attribution");
    expect(upgradePage).toContain("Collection health · not P&L proof");
    expect(upgradePage).toContain("/api/admin/shadow-liveness");
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
