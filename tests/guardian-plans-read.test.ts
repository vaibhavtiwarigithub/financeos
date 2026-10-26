import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ owner: vi.fn(), read: vi.fn(), report: vi.fn(), resolve: vi.fn() }));
const svc = { from: () => ({ select: () => ({ in: () => ({ order: mocks.read }) }) }) };
vi.mock("@/lib/auth/require-owner", () => ({ requireOwner: mocks.owner }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => svc }));
vi.mock("@/lib/system-health", () => ({ reportIssue: mocks.report, resolveIssue: mocks.resolve }));
import { GET } from "@/app/api/manual-trade-guardian/plans/route";

describe("US Guardian plan read health", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.owner.mockResolvedValue(null); });
  it("returns unavailable and reports a failed read instead of an empty plan book", async () => {
    mocks.read.mockResolvedValue({ data: null, error: { message: "offline" } });
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).not.toHaveProperty("plans");
    expect(mocks.report).toHaveBeenCalledWith(expect.objectContaining({ issueKey: "guardian-plans:us" }), svc);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it("resolves only after a successful ledger read", async () => {
    mocks.read.mockResolvedValue({ data: [], error: null });
    expect(await (await GET()).json()).toEqual({ plans: [] });
    expect(mocks.resolve).toHaveBeenCalledWith("guardian-plans:us", svc);
  });
  it("does not read the ledger for an unauthenticated request", async () => {
    mocks.owner.mockResolvedValue(new Response("denied", { status: 401 }));
    expect((await GET()).status).toBe(401);
    expect(mocks.read).not.toHaveBeenCalled();
  });
});
