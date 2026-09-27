import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SHADOW_PROGRAMS } from "@/lib/shadows/registry";
import { liveExitShadowMode } from "@/lib/trading/live-exit-monitor";
import {
  evaluateShadowLiveness,
  missingProbeProgramIds,
  SHADOW_EVIDENCE_PROBES,
  type CronEvidence,
} from "@/lib/shadows/liveness";

const activeCronRows = (jobs: readonly string[]): CronEvidence[] => jobs.map((jobname) => ({
  jobname, schedule: "0 2 * * 1-5", active: true,
  last_started_at: "2026-09-26T11:00:00Z", last_status: "succeeded",
}));

describe("Upgrade Path liveness contracts", () => {
  it("has an explicit collection contract for every registry entry", () => {
    expect(missingProbeProgramIds(SHADOW_PROGRAMS)).toEqual([]);
    expect(Object.keys(SHADOW_EVIDENCE_PROBES).sort()).toEqual(SHADOW_PROGRAMS.map((program) => program.id).sort());
  });

  it("distinguishes a legitimate event-driven wait from an empty scheduled producer", () => {
    const rotation = SHADOW_PROGRAMS.find((program) => program.id === "capital-rotation")!;
    const waiting = evaluateShadowLiveness({
      program: rotation,
      market: "us",
      probe: SHADOW_EVIDENCE_PROBES[rotation.id],
      count: 0,
      lastWrite: null,
      cronRows: [],
      nowMs: Date.parse("2026-09-26T12:00:00Z"),
    });
    expect(waiting.verdict).toBe("waiting_for_input");

    const scoreExit = SHADOW_PROGRAMS.find((program) => program.id === "score-exit-shadow")!;
    const missing = evaluateShadowLiveness({
      program: scoreExit,
      market: "us",
      probe: SHADOW_EVIDENCE_PROBES[scoreExit.id],
      count: 0,
      lastWrite: null,
      cronRows: activeCronRows(scoreExit.cronJobs),
      nowMs: Date.parse("2026-09-26T12:00:00Z"),
    });
    expect(missing.verdict).toBe("empty");
  });

  it("treats time-review observations as event-driven while still requiring its scheduled runner", () => {
    const program = SHADOW_PROGRAMS.find((candidate) => candidate.id === "horizon-extension")!;
    const probe = SHADOW_EVIDENCE_PROBES[program.id];
    expect(program.cronJobs).toEqual(["kairos-position-monitor", "kairos-position-monitor-india"]);
    const noCheckpoint = evaluateShadowLiveness({
      program, market: "us", probe, count: 0, lastWrite: null,
      cronRows: activeCronRows(program.marketCronJobs?.us ?? []),
      nowMs: Date.parse("2026-09-27T12:00:00Z"),
    });
    expect(noCheckpoint.verdict).toBe("waiting_for_input");

    const missingRunner = evaluateShadowLiveness({
      program, market: "us", probe, count: 0, lastWrite: null,
      cronRows: [], nowMs: Date.parse("2026-09-27T12:00:00Z"),
    });
    expect(missingRunner.verdict).toBe("missing_schedule");

    const wrongMarketOnly = evaluateShadowLiveness({
      program, market: "us", probe, count: 0, lastWrite: null,
      cronRows: activeCronRows(program.marketCronJobs?.india ?? []),
      nowMs: Date.parse("2026-09-27T12:00:00Z"),
    });
    expect(wrongMarketOnly.verdict).toBe("missing_schedule");
  });

  it("treats setup-expert rows as event-driven but proves the market-local ResearchAgent ran", () => {
    const program = SHADOW_PROGRAMS.find((candidate) => candidate.id === "setup-experts")!;
    const probe = SHADOW_EVIDENCE_PROBES[program.id];
    expect(program.marketCronJobs).toEqual({
      us: ["kairos-research"],
      india: ["kairos-research-india"],
    });

    const waiting = evaluateShadowLiveness({
      program, market: "us", probe, count: 0, lastWrite: null,
      cronRows: activeCronRows(program.marketCronJobs?.us ?? []),
      nowMs: Date.parse("2026-09-27T12:00:00Z"),
    });
    expect(waiting.verdict).toBe("waiting_for_input");
    expect(waiting.schedules).toHaveLength(1);

    const missingCollector = evaluateShadowLiveness({
      program, market: "india", probe, count: 0, lastWrite: null,
      cronRows: activeCronRows(program.marketCronJobs?.us ?? []),
      nowMs: Date.parse("2026-09-27T12:00:00Z"),
    });
    expect(missingCollector.verdict).toBe("missing_schedule");

    const staleCollector = evaluateShadowLiveness({
      program, market: "us", probe, count: 0, lastWrite: null,
      cronRows: [{ jobname: "kairos-research", schedule: "0 13,14 * * 1-5", active: true, last_started_at: "2026-09-20T14:00:00Z", last_status: "succeeded" }],
      nowMs: Date.parse("2026-09-27T12:00:00Z"),
    });
    expect(staleCollector.verdict).toBe("stale_schedule_run");
  });

  it("does not call an unregistered or inactive scheduled collector live", () => {
    const program = SHADOW_PROGRAMS.find((candidate) => candidate.id === "score-exit-shadow")!;
    const missing = evaluateShadowLiveness({
      program,
      market: "us",
      probe: SHADOW_EVIDENCE_PROBES[program.id],
      count: 50,
      lastWrite: "2026-09-26T11:00:00Z",
      cronRows: [],
      nowMs: Date.parse("2026-09-26T12:00:00Z"),
    });
    expect(missing.verdict).toBe("missing_schedule");

    const inactive = evaluateShadowLiveness({
      program,
      market: "us",
      probe: SHADOW_EVIDENCE_PROBES[program.id],
      count: 50,
      lastWrite: "2026-09-26T11:00:00Z",
      cronRows: program.cronJobs.map((jobname) => ({ jobname, schedule: "0 2 * * 1-5", active: false, last_started_at: null, last_status: null })),
      nowMs: Date.parse("2026-09-26T12:00:00Z"),
    });
    expect(inactive.verdict).toBe("inactive_schedule");
  });

  it("checks only the selected market's market-local cron and does not call old event evidence currently live", () => {
    const program = SHADOW_PROGRAMS.find((candidate) => candidate.id === "score-price-divergence")!;
    const usJob = program.cronJobs.find((job) => job.endsWith("-us"))!;
    const usOnly = evaluateShadowLiveness({
      program, market: "us", probe: SHADOW_EVIDENCE_PROBES[program.id], count: 12,
      lastWrite: "2026-09-26T11:00:00Z", cronRows: activeCronRows([usJob]),
      nowMs: Date.parse("2026-09-26T12:00:00Z"),
    });
    expect(usOnly.verdict).toBe("live");
    expect(usOnly.schedules).toHaveLength(1);
    expect(usOnly.schedules[0].job).toBe(usJob);

    const rotation = SHADOW_PROGRAMS.find((candidate) => candidate.id === "capital-rotation")!;
    const oldEvent = evaluateShadowLiveness({
      program: rotation, market: "us", probe: SHADOW_EVIDENCE_PROBES[rotation.id], count: 5,
      lastWrite: "2026-08-01T00:00:00Z", cronRows: [], nowMs: Date.parse("2026-09-26T12:00:00Z"),
    });
    expect(oldEvent.verdict).toBe("waiting_for_input");
    expect(oldEvent.note).toContain("past row is not proof of current eligible input");
  });

  it("uses the secured last-run cron proof instead of treating an active schedule as a successful run", () => {
    const program = SHADOW_PROGRAMS.find((candidate) => candidate.id === "live-exit-ladder-parity")!;
    const probe = SHADOW_EVIDENCE_PROBES[program.id];
    const failed = evaluateShadowLiveness({
      program,
      market: "us",
      probe,
      count: 28,
      lastWrite: "2026-09-16T20:00:00Z",
      cronRows: program.cronJobs.map((jobname) => ({ jobname, schedule: "0 3-20 * * 1-5", active: true, last_started_at: "2026-09-25T20:00:00Z", last_status: "failed" })),
      nowMs: Date.parse("2026-09-26T12:00:00Z"),
    });
    expect(failed.verdict).toBe("failed_schedule_run");

    const stale = evaluateShadowLiveness({
      program,
      market: "us",
      probe,
      count: 28,
      lastWrite: "2026-09-16T20:00:00Z",
      cronRows: program.cronJobs.map((jobname) => ({ jobname, schedule: "0 3-20 * * 1-5", active: true, last_started_at: "2026-09-20T20:00:00Z", last_status: "succeeded" })),
      nowMs: Date.parse("2026-09-26T12:00:00Z"),
    });
    expect(stale.verdict).toBe("stale_schedule_run");
  });

  it("calls disabled programs expected-empty only when they have no stray active job", () => {
    const program = SHADOW_PROGRAMS.find((candidate) => candidate.id === "autonomous-live")!;
    const probe = SHADOW_EVIDENCE_PROBES[program.id];
    expect(evaluateShadowLiveness({ program, market: "us", probe, count: 0, lastWrite: null, cronRows: [], nowMs: Date.now() }).verdict).toBe("expected_empty");
    const stray = evaluateShadowLiveness({
      program,
      market: "us",
      probe,
      count: 0,
      lastWrite: null,
      cronRows: activeCronRows(program.cronJobs),
      nowMs: Date.now(),
    });
    expect(stray.verdict).toBe("unexpected_schedule");
  });

  it("requires valid recency and labels stale rows instead of treating counts as health", () => {
    const program = SHADOW_PROGRAMS.find((candidate) => candidate.id === "score-exit-shadow")!;
    const result = evaluateShadowLiveness({
      program,
      market: "us",
      probe: SHADOW_EVIDENCE_PROBES[program.id],
      count: 88,
      lastWrite: "2026-09-10T00:00:00Z",
      cronRows: activeCronRows(program.cronJobs),
      nowMs: Date.parse("2026-09-26T12:00:00Z"),
    });
    expect(result.verdict).toBe("frozen");
    expect(result.note).toContain("No evidence for");
  });

  it("does not let the deployment-level live-execution kill switch disable shadow collection", () => {
    expect(liveExitShadowMode(false, false)).toBe(true);
    expect(liveExitShadowMode(false, true)).toBe(true);
    expect(liveExitShadowMode(true, false)).toBe(true);
    expect(liveExitShadowMode(true, true)).toBe(false);
  });

  it("exposes only service-role cron run metadata for the liveness audit", () => {
    const migration = readFileSync("supabase/migrations/20260926191851_shadow_cron_run_health.sql", "utf8");
    const route = readFileSync("app/api/admin/shadow-liveness/route.ts", "utf8");
    expect(migration).toContain("cron.job_run_details");
    expect(migration).toContain("revoke all on function public.get_shadow_cron_health() from public, anon, authenticated");
    expect(migration).toContain("grant execute on function public.get_shadow_cron_health() to service_role");
    expect(route).toContain('rpc("get_shadow_cron_health")');
    expect(route).toContain("cron_jobs: scheduledJobsForMarket(program, market)");
  });
});
