import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ owner: vi.fn(), read: vi.fn(), config: vi.fn(), scan: vi.fn(), report: vi.fn(), resolve: vi.fn() }));
const svc = { from: (table: string) => ({ select: () => table === "strategy_config"
  ? { limit: () => ({ maybeSingle: mocks.config }) }
  : table === "agentic_position_scan_state" ? { eq: () => ({ maybeSingle: mocks.scan }) }
  : { in: () => ({ order: mocks.read }) } }) };
vi.mock("@/lib/autonomy", () => ({ AUTONOMOUS_LIVE_ENABLED: false }));
vi.mock("@/lib/auth/require-owner", () => ({ requireOwner: mocks.owner }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => svc }));
vi.mock("@/lib/system-health", () => ({ reportIssue: mocks.report, resolveIssue: mocks.resolve }));
import { GET } from "@/app/api/manual-trade-guardian/plans/route";

describe("US Guardian plan read health", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.owner.mockResolvedValue(null);
    mocks.config.mockResolvedValue({ data: { live_auto_enabled: false, active_account_us: "605420660" }, error: null });
    mocks.scan.mockResolvedValue({ data: { last_completed_at: "2026-09-16T20:00:06Z" }, error: null });
  });
  it("returns unavailable and reports a failed read instead of an empty plan book", async () => {
    mocks.read.mockResolvedValue({ data: null, error: { message: "offline" } });
    const response = await GET();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).not.toHaveProperty("plans");
    expect(mocks.report).toHaveBeenCalledWith(expect.objectContaining({ issueKey: "guardian-plans:us" }), svc);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it("resolves only after a successful ledger read", async () => {
    mocks.read.mockResolvedValue({ data: [], error: null });
    const response = await GET();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ plans: [], runtime: { deploymentEnabled: false, liveEnabled: false, lastScanCompletedAt: "2026-09-16T20:00:06Z" } });
    expect(mocks.resolve).toHaveBeenCalledWith("guardian-plans:us", svc);
  });
  it("distinguishes unavailable configuration and scan state from disabled or empty", async () => {
    mocks.read.mockResolvedValue({ data: [], error: null });
    mocks.config.mockResolvedValue({ data: null, error: { message: "offline" } });
    mocks.scan.mockResolvedValue({ data: null, error: { message: "offline" } });
    const body = await (await GET()).json();
    expect(body.runtime).toMatchObject({ configurationAvailable: false, liveEnabled: null, scanAvailable: false, lastScanCompletedAt: null });
    expect(JSON.stringify(body)).not.toContain("605420660");
    expect(mocks.resolve).not.toHaveBeenCalledWith("guardian-scan:us", svc);
  });
  it("does not read the ledger for an unauthenticated request", async () => {
    mocks.owner.mockResolvedValue(new Response("denied", { status: 401 }));
    expect((await GET()).status).toBe(401);
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.config).not.toHaveBeenCalled();
    expect(mocks.scan).not.toHaveBeenCalled();
  });
});
