import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mock = vi.hoisted(() => ({ gate: vi.fn(), service: vi.fn(), statuses: vi.fn(), health: vi.fn(), evaluations: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/auth/require-owner", () => ({ requireOwner: mock.gate }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: mock.service }));
vi.mock("@/lib/shadows/status", () => ({ getShadowProgramStatuses: mock.statuses }));
vi.mock("@/lib/shadows/collection-health", () => ({ loadShadowCollectionHealth: mock.health }));
vi.mock("@/lib/shadows/evaluation-results", () => ({ loadStoredShadowEvaluations: mock.evaluations, evaluationCellDescription: () => "Stored result" }));
import { GET } from "@/app/api/upgrade-path/route";

const base = { id: "exit-stop-shadow", name: "ATR", markets: ["us"], available: true, lifecycle: "collecting", blockers: ["Need 2 blocks"], details: [], calls: { mode: "zero_incremental" },
  progress: { target: 2, completed: 1 }, owner: "Evidence", reviewDate: "2026-12-01", mainline: { implementationScope: "measure_only" }, attribution: { comparisonType: "matched_replay", state: "producer_missing", reason: "Missing result" } };
beforeEach(() => {
  vi.clearAllMocks(); mock.gate.mockResolvedValue(null); mock.service.mockReturnValue({ rpc: mock.rpc });
  mock.statuses.mockResolvedValue([base]); mock.health.mockResolvedValue({ programs: [{ id: base.id, market: "us", verdict: "live", note: "Fresh collector" }] });
  mock.evaluations.mockResolvedValue([]);
  mock.rpc.mockImplementation(async (name: string) => ({ error: null, data: name === "get_upgrade_path_shadow_book_latest" ? [{ program_id: base.id, market: "us", session_date: "2026-10-22", window_start: "2026-09-25", independent_blocks: 1 }] : [] }));
});
describe("Upgrade Path completion API", () => {
  it("denies before any privileged read", async () => {
    mock.gate.mockResolvedValue(new Response("Unauthorized", { status: 401 }));
    expect((await GET(new NextRequest("https://example.test/api/upgrade-path?market=us"))).status).toBe(401);
    expect(mock.service).not.toHaveBeenCalled(); expect(mock.health).not.toHaveBeenCalled();
  });
  it("does not create a client for an invalid market", async () => {
    expect((await GET(new NextRequest("https://example.test/api/upgrade-path?market=other"))).status).toBe(400);
    expect(mock.service).not.toHaveBeenCalled();
  });
  it("assesses after the paired-book overlay; a real immature producer is collecting, not missing", async () => {
    const body = await (await GET(new NextRequest("https://example.test/api/upgrade-path?market=us"))).json();
    expect(body.programs[0].completion.state).toBe("collecting");
    expect(body.programs[0].completion.reason).toContain("1/2");
    expect(mock.health).toHaveBeenCalledWith(mock.service.mock.results[0].value, "us");
    expect(body.summary.completion.buildComparison).toBe(0);
  });
  it("does not revive a US-only path in India via a stray evaluator", async () => {
    mock.statuses.mockResolvedValue([{ ...base, lifecycle: "not_applicable", id: "insider-v2-shadow" }]);
    mock.health.mockResolvedValue({ programs: [] });
    mock.evaluations.mockResolvedValue([{ id: "insider-v2-shadow", cells: [{ classification: "measured_descriptive" }] }]);
    const body = await (await GET(new NextRequest("https://example.test/api/upgrade-path?market=india"))).json();
    expect(body.programs[0].completion.state).toBe("not_applicable");
    expect(body.summary.completion.applicable).toBe(0); expect(body.summary.attribution.performanceEligible).toBe(0);
  });
  it("keeps evaluator read failures explicit rather than an empty or ready result", async () => {
    mock.evaluations.mockResolvedValue([{ id: base.id, cells: [], error: "DB read failed", href: "/dashboard/learning", evaluatedAt: null, batchId: null }]);
    const body = await (await GET(new NextRequest("https://example.test/api/upgrade-path?market=us"))).json();
    expect(body.programs[0].completion.state).toBe("repair");
    expect(body.programs[0].available).toBe(false);
    expect(body.programs[0].blockers[0]).toContain("DB read failed");
  });
  it("does not turn a hindsight fit into forward analysis readiness", async () => {
    const id = "score-variants-forward-shadow";
    mock.statuses.mockResolvedValue([{ ...base, id, attribution: { comparisonType: "operational_only", state: "not_attributable", reason: "Formula diagnostic" } }]);
    mock.evaluations.mockResolvedValue([{ id, cells: [{ sample: "hindsight", classification: "measured_descriptive" }, { sample: "forward", classification: "insufficient_evidence" }], error: null, href: "/dashboard/learning", evaluatedAt: new Date().toISOString(), batchId: "batch" }]);
    const body = await (await GET(new NextRequest("https://example.test/api/upgrade-path?market=us"))).json();
    expect(body.programs[0].lifecycle).toBe("collecting");
    expect(body.programs[0].benefitEvidence).toContain("0 forward descriptive, 1 hindsight descriptive");
  });
});
