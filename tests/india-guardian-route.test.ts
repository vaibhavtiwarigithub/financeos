import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ owner: vi.fn(), holdings: vi.fn(), gtts: vi.fn(), report: vi.fn(), resolve: vi.fn() }));
vi.mock("@/lib/auth/require-owner", () => ({ requireOwner: mocks.owner }));
vi.mock("@/lib/kite", () => ({ getKiteHoldings: mocks.holdings, kiteGet: mocks.gtts }));
vi.mock("@/lib/system-health", () => ({ reportIssue: mocks.report, resolveIssue: mocks.resolve }));
import { GET } from "@/app/api/live-portfolio/india-guardian/route";

describe("India Guardian source truth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.owner.mockResolvedValue(null);
    mocks.holdings.mockResolvedValue({ ok: true, data: [{ tradingsymbol: "INFY", exchange: "NSE", quantity: 10, last_price: 1600, average_price: 1800 }] });
    mocks.gtts.mockResolvedValue({ ok: true, data: [] });
  });
  it("denies anonymous access before broker reads", async () => {
    mocks.owner.mockResolvedValue(new Response("denied", { status: 401 }));
    expect((await GET()).status).toBe(401);
    expect(mocks.holdings).not.toHaveBeenCalled();
  });
  it.each([undefined, null, {}, [null], [{ tradingsymbol: "INFY", exchange: "NSE", quantity: "bad" }]])("keeps malformed holdings unavailable: %j", async data => {
    mocks.holdings.mockResolvedValue({ ok: true, data });
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ holdingsAvailable: false });
    expect(mocks.report).toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it.each([null, {}, [null]])("keeps malformed GTT book unknown rather than empty: %j", async data => {
    mocks.gtts.mockResolvedValue({ ok: true, data });
    const body = await (await GET()).json();
    expect(body).toMatchObject({ holdingsAvailable: true, gttAvailable: false });
    expect(body.positions[0].protection.state).toBe("unknown");
    expect(mocks.report).toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it("contains a rejected GTT read without losing valid holdings", async () => {
    mocks.gtts.mockRejectedValue(new Error("provider offline"));
    const body = await (await GET()).json();
    expect(body.positions[0].protection.state).toBe("unknown");
  });
  it("accepts a verified empty book and resolves only its own source warning", async () => {
    mocks.holdings.mockResolvedValue({ ok: true, data: [] });
    const body = await (await GET()).json();
    expect(body).toMatchObject({ holdingsAvailable: true, gttAvailable: true, positions: [] });
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith("guardian-coverage:india");
  });
});
