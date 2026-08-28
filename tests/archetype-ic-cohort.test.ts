import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Pins the cohort contract of the archetype grader.
//
// THE BUG THIS GUARDS AGAINST (2026-08-28): the route graded every archetype
// against every scored observation, including `neutral` and `short` rows the
// book could never buy. That is the same error that produced a published
// India "+0.105 selection edge" whose eligible-long value is -0.0083.
//
// The fixture is built so the two cohorts disagree in SIGN: eligible-long rows
// rank backwards, ineligible rows rank forwards. A grader on the wrong cohort
// reports a positive IC and fails here.

const h = vi.hoisted(() => ({ from: vi.fn() }));

vi.mock("@/lib/auth/require-owner", () => ({ requireOwner: vi.fn(async () => null) }));
vi.mock("@/lib/auth/cron", () => ({ verifyCronSecret: () => true }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({ from: h.from }) }));

function shadowRow(date: string, i: number, eligible: boolean) {
  return {
    setup_type: "value_inflection",
    symbol: eligible ? `E${i}` : `N${i}`,
    ts: `${date}T13:00:00Z`,
    score: eligible ? 50 + i : 70 + i,
    observation_id: `${date}-${eligible ? "e" : "n"}-${i}`,
    decision_observations: {
      analyst_score: eligible ? 50 + i : 70 + i,
      ts: `${date}T13:00:00Z`,
      entry_eligible: eligible,
      direction: eligible ? "long" : "neutral",
      observation_labels: [{
        horizon_days: 10,
        // eligible: higher score -> WORSE return. ineligible: the reverse.
        benchmark_neutral_return: eligible ? -i : 10 + i,
      }],
    },
  };
}

function rows() {
  const out: any[] = [];
  for (let d = 0; d < 25; d++) {
    const date = `2026-07-${String((d % 28) + 1).padStart(2, "0")}`;
    for (let i = 0; i < 5; i++) out.push(shadowRow(date, i, true));
    for (let i = 0; i < 5; i++) out.push(shadowRow(date, i, false));
  }
  return out;
}

function builder(data: any[]) {
  let served = false;
  const b: any = {
    select: () => b, eq: () => b, not: () => b, order: () => b,
    // The route pages with .range(); serve everything once, then an empty page.
    range: () => {
      const page = served ? [] : data;
      served = true;
      return Promise.resolve({ data: page, error: null });
    },
  };
  return b;
}

// A shadow row for an arm whose observations have NOT matured — no label join.
function unmaturedArm(setupType: string) {
  return { setup_type: setupType, symbol: "X", ts: "2026-07-01T13:00:00Z", score: 60, observation_id: `u-${setupType}`, decision_observations: null };
}

describe("archetype IC cohort", () => {
  it("grades only entry-eligible long observations", async () => {
    h.from.mockImplementation(() => builder(rows()));
    const { GET } = await import("@/app/api/agents/archetype-ic/route");
    const res = await GET(new NextRequest("http://localhost/api/agents/archetype-ic?market=us&horizon=10"));
    const body = await res.json();

    expect(body.persisted).toBe(false);
    const report = body.reports.find((r: any) => r.setupType === "value_inflection");
    expect(report).toBeTruthy();
    // 25 dates x 5 eligible names. The ineligible half must not be graded.
    expect(report.observations).toBe(125);
    expect(report.rankIc).toBeCloseTo(-1, 6);
    // The persisted row must SAY which population it measured; archetype_ic_runs
    // cannot otherwise distinguish a corrected grade from a contaminated one.
    expect(report.cohort).toBe("eligible_long");
    expect(report.reason).toContain("[eligible_long]");
  });
});

describe("arms that cannot be graded", () => {
  // THE GAP THIS CLOSES: loadRows inner-joins matured labels, so an arm whose
  // observations have not matured is dropped BEFORE grouping and never reaches
  // the eligible-rows check. In production that silently erased 6 of 8 US arms
  // and all 3 India arms — indistinguishable in the ledger from "never ran".
  it("records an explicit refusal for an arm with no matured labels", async () => {
    const data = [...rows(), unmaturedArm("fundamental_only")];
    h.from.mockImplementation(() => builder(data));
    const { GET } = await import("@/app/api/agents/archetype-ic/route");
    const res = await GET(new NextRequest("http://localhost/api/agents/archetype-ic?market=us&horizon=10"));
    const body = await res.json();

    const missing = body.reports.find((r: any) => r.setupType === "fundamental_only");
    expect(missing).toBeTruthy();
    expect(missing.status).toBe("insufficient_evidence");
    expect(missing.rankIc).toBeNull();
    expect(missing.observations).toBe(0);
    expect(missing.cohort).toBe("eligible_long");
    // Must say WHY, and must not read as a negative result.
    expect(missing.reason).toContain("matured");
    expect(missing.reason).toContain("Not a negative result");
  });
});
