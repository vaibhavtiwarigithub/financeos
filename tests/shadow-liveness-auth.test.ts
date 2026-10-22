import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ gate: vi.fn(), service: vi.fn(), rpc: vi.fn(), from: vi.fn(), count: 1 as number | undefined }));
vi.mock("@/lib/auth/require-owner", () => ({ requireOwner: mocks.gate }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: mocks.service }));
vi.mock("@/lib/shadows/registry", () => ({ SHADOW_PROGRAMS: [{ id: "test", name: "Test", markets: ["us"], category: "test", attributionClass: "operational_only", currentInfluence: "none" }] }));
vi.mock("@/lib/shadows/liveness", () => ({
  evaluateShadowLiveness: () => ({ verdict: "live" }), missingProbeProgramIds: () => [], scheduledJobsForMarket: () => [],
  SHADOW_EVIDENCE_PROBES: { test: { mode: "scheduled", table: "test_evidence", tsCol: "created_at", marketCol: "market" } },
}));
import { GET } from "@/app/api/admin/shadow-liveness/route";

beforeEach(() => {
  vi.clearAllMocks(); mocks.count = 1; mocks.gate.mockResolvedValue(null);
  mocks.rpc.mockResolvedValue({ data: [], error: null });
  mocks.from.mockImplementation(() => {
    let head = false;
    const q: any = {
      select: (_: unknown, options?: { head?: boolean }) => { head = !!options?.head; return q; },
      eq: () => q, not: () => q, order: () => q, limit: () => q,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(head ? { count: mocks.count, error: null } : { data: [{ created_at: "2026-10-22T00:00:00Z" }], error: null }).then(resolve),
    };
    return q;
  });
  mocks.service.mockReturnValue({ rpc: mocks.rpc, from: mocks.from });
});
describe("shadow liveness privileged read boundary", () => {
  it("never creates a privileged client for a denied caller", async () => {
    mocks.gate.mockResolvedValue(new Response("Forbidden", { status: 403 }));
    expect((await GET()).status).toBe(403);
    expect(mocks.service).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("uses the isolated service RPC only after owner authorization", async () => {
    const response = await GET(); const body = await response.json();
    expect(response.status).toBe(200); expect(mocks.rpc).toHaveBeenCalledWith("get_shadow_cron_health");
    expect(mocks.gate.mock.invocationCallOrder[0]).toBeLessThan(mocks.service.mock.invocationCallOrder[0]);
    expect(body.programs[0].verdict).toBe("live");
  });
  it("does not turn an absent evidence count into a healthy zero", async () => {
    mocks.count = undefined;
    const body = await (await GET()).json();
    expect(body.programs[0].verdict).toBe("unknown");
    expect(body.programs[0].note).toBe("Evidence count unavailable.");
  });
});
