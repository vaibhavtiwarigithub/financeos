import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { describeRotationExecutor, loadRotationStatus } from "@/lib/agents/rotation-status";

function chain(result: unknown) {
  const c: any = {
    select: () => c, eq: () => c, order: () => c, limit: () => c,
    maybeSingle: async () => result,
    then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
  };
  return c;
}

function client(config: any[], events: any[] = []) {
  return {
    from: (table: string) => chain(
      table === "rotation_events" ? { data: events, error: null }
        : table === "rotation_config" ? { data: config, error: null }
          : { data: { turnover_budget_monthly: 20, tax_sensitivity: "medium" }, error: null }),
  };
}

const paper = (over: Record<string, unknown> = {}) => ({
  book_type: "paper", rotation_shadow_enabled: true, rotation_paper_execute_enabled: true,
  rotation_allow_score_only_paper: false, rotation_live_proposals_enabled: false, ...over,
});
const live = (over: Record<string, unknown> = {}) => ({
  book_type: "live", rotation_shadow_enabled: true, rotation_paper_execute_enabled: false,
  rotation_allow_score_only_paper: false, rotation_live_proposals_enabled: false, ...over,
});

describe("describeRotationExecutor: an enabled switch is not an executable rotation", () => {
  const open = { dbExecuteFlag: true, deploymentGate: true, scoreOnlyAllowed: true };
  it("is disabled when the DB paper flag is off, whatever else is open", () => {
    expect(describeRotationExecutor({ ...open, dbExecuteFlag: false, latestP1Ready: true })).toBe("disabled");
  });
  it("is inert (keys_missing) when the DB flag is on but the deployment gate or score-only key is closed", () => {
    expect(describeRotationExecutor({ ...open, deploymentGate: false, latestP1Ready: true })).toBe("keys_missing");
    expect(describeRotationExecutor({ ...open, scoreOnlyAllowed: false, latestP1Ready: true })).toBe("keys_missing");
  });
  it("is armed_blocked with every key open but no passing P1 contract (null or false)", () => {
    expect(describeRotationExecutor({ ...open, latestP1Ready: false })).toBe("armed_blocked");
    expect(describeRotationExecutor({ ...open, latestP1Ready: null })).toBe("armed_blocked");
  });
  it("is armed_ready only with every key open and a passing latest P1 contract", () => {
    expect(describeRotationExecutor({ ...open, latestP1Ready: true })).toBe("armed_ready");
  });
});

describe("loadRotationStatus", () => {
  const portfolioPage = readFileSync("app/dashboard/portfolio/page.tsx", "utf8");
  const original = process.env.CAPITAL_ROTATION_PAPER_ENABLED;
  afterEach(() => {
    if (original == null) delete process.env.CAPITAL_ROTATION_PAPER_ENABLED;
    else process.env.CAPITAL_ROTATION_PAPER_ENABLED = original;
  });
  const blockedEvent = {
    id: 7,
    created_at: "2026-09-28T07:45:00Z", status: "planned", audit_json: { run_id: "r1", p1_ready: false },
    candidate_symbol: "NEW", source_symbol: "HELD", candidate_score: 82, source_score: 70,
    score_edge: 12, buy_notional: 500, sell_notional: 400, turnover_consumed: 900,
    gate_results_json: {
      p1_ready: false, p1_blockers: ["score_to_return_mapping_unvalidated"],
      persistence_prior_runs: 1, persistence_required_prior_runs: 2,
      monthly_turnover_used_pct: 4, proposed_turnover_pct: 9,
      exact_tax_lot: { available: false, treatment: "unavailable" }, post_swap_allowed: true,
      score_to_return_mapping: { status: "insufficient", independentSessions: 5, requiredIndependentSessions: 20 },
      candidate_correlation: { status: "ok", pairCount: 3, expectedPairCount: 3 },
      post_swap_adjustments: ["re-sized after sale"],
    },
  };

  it("reports the production state: DB flag on, score-only key closed, live off => inert, not 'misconfigured'", async () => {
    process.env.CAPITAL_ROTATION_PAPER_ENABLED = "true";
    const status = await loadRotationStatus(client([paper(), live()], [blockedEvent]), "india");
    expect(status.executionEnabled).toBe(true);
    expect(status.keys).toEqual({ dbExecuteFlag: true, deploymentGate: true, scoreOnlyAllowed: false });
    expect(status.executor).toBe("keys_missing");
    expect(status.liveRotationOff).toBe(true);
    expect(status.latestBlockers).toEqual(["score_to_return_mapping_unvalidated"]);
    expect(status.nextAction).toContain("inert");
    expect(status.paperExecutedCount).toBe(0);
  });

  it("reads the deployment gate from the running environment and treats anything but 'true' as closed", async () => {
    process.env.CAPITAL_ROTATION_PAPER_ENABLED = "1";
    const status = await loadRotationStatus(client([paper({ rotation_allow_score_only_paper: true }), live()], [blockedEvent]), "us");
    expect(status.keys.deploymentGate).toBe(false);
    expect(status.executor).toBe("keys_missing");
  });

  it("flags any live rotation flag as not off", async () => {
    process.env.CAPITAL_ROTATION_PAPER_ENABLED = "true";
    expect((await loadRotationStatus(client([paper(), live({ rotation_live_proposals_enabled: true })], []), "us")).liveRotationOff).toBe(false);
    expect((await loadRotationStatus(client([paper(), live({ rotation_paper_execute_enabled: true })], []), "us")).liveRotationOff).toBe(false);
    expect((await loadRotationStatus(client([], []), "us")).liveRotationOff).toBe(false);
  });

  it("counts executed rotations only from paper_executed rows", async () => {
    process.env.CAPITAL_ROTATION_PAPER_ENABLED = "true";
    const status = await loadRotationStatus(client([paper({ rotation_allow_score_only_paper: true }), live()],
      [{ ...blockedEvent, status: "paper_executed" }, blockedEvent]), "us");
    expect(status.paperExecutedCount).toBe(1);
  });

  it("projects auditable event details only when explicitly requested", async () => {
    process.env.CAPITAL_ROTATION_PAPER_ENABLED = "true";
    const status = await loadRotationStatus(client([paper({ rotation_allow_score_only_paper: true }), live()], [blockedEvent]), "us", true);
    expect(status.activity[0]).toMatchObject({
      id: "7", candidateSymbol: "NEW", sourceSymbol: "HELD", scoreEdge: 12,
      p1Ready: false, p1ContractRecorded: true, blockers: ["score_to_return_mapping_unvalidated"],
      persistencePriorRuns: 1, persistenceRequiredPriorRuns: 2,
      monthlyTurnoverUsedPct: 4, proposedTurnoverPct: 9,
      postSwapAllowed: true, postSwapAdjustments: ["re-sized after sale"],
    });
    expect(status.activity[0].candidateCorrelation).toMatchObject({ pairCount: 3, expectedPairCount: 3 });
    expect(status.activity[0].scoreToReturn).toMatchObject({ independentSessions: 5, requiredIndependentSessions: 20 });
  });

  it("omits event detail for aggregate callers by default", async () => {
    const status = await loadRotationStatus(client([paper(), live()], [blockedEvent]), "us");
    expect(status.eventCount).toBe(1);
    expect(status.activity).toEqual([]);
  });

  it("loads event-level service-role diagnostics only for a confirmed owner", () => {
    expect(portfolioPage).toContain('role === "owner" ? loadRotationStatus(supabase, market, true) : Promise.resolve(null)');
  });
});

describe("paper-trade zero-size handling (contract)", () => {
  const source = readFileSync("app/api/agents/paper-trade/route.ts", "utf8");
  it("skips a zero proposed size as a sizing verdict before the constructor, rotation and missed-entry ledger", () => {
    const branch = source.indexOf('reason: "sizing_no_positive_edge"');
    const constructor = source.indexOf("const constructed = constructPortfolio(");
    const rotation = source.indexOf("recordCapitalRotationShadow(supabase");
    expect(branch).toBeGreaterThan(0);
    expect(branch).toBeGreaterThan(constructor); // after the pure call: correlation-shadow boundary forbids skips before it
    expect(branch).toBeLessThan(source.indexOf("classifyConstructorSize(rawSizedPct)"));
    expect(branch).toBeLessThan(rotation);
    const block = source.slice(source.lastIndexOf("if (Number.isFinite(proposedSizePct) && proposedSizePct <= 0)", branch), branch + 400);
    expect(block).toContain("revertClaim(signal.id)");
    expect(block).not.toContain("recordMissedEntry");
  });
  it("leaves non-finite sizes to the constructor's fail-closed branch", () => {
    expect(source).toContain("Number.isFinite(proposedSizePct) && proposedSizePct <= 0");
  });
});
