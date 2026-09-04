import { beforeEach, describe, expect, it, vi } from "vitest";

const kite = vi.hoisted(() => ({
  getKiteHoldings: vi.fn(),
  getKiteMargins: vi.fn(),
  getKiteMutualFundHoldings: vi.fn(),
}));

vi.mock("@/lib/auth/require-owner", () => ({ requireOwner: vi.fn(async () => null) }));
vi.mock("@/lib/kite", () => kite);

describe("Kite portfolio Coin sleeve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    kite.getKiteHoldings.mockResolvedValue({
      ok: true,
      data: [{ tradingsymbol: "TCS", exchange: "NSE", quantity: 2, average_price: 100, last_price: 120, pnl: 40 }],
    });
    kite.getKiteMargins.mockResolvedValue({ ok: true, equityNet: 1000 });
  });

  it("keeps equity holdings and legacy NAV when Coin is unavailable", async () => {
    kite.getKiteMutualFundHoldings.mockResolvedValue({ ok: false, error: "Coin unavailable" });
    const { GET } = await import("@/app/api/kite/portfolio/route");
    const body = await (await GET()).json();

    expect(body.holdings).toHaveLength(1);
    expect(body.nav).toBe(1240);
    expect(body.combined_nav).toBeNull();
    expect(body.coin).toMatchObject({ available: false, holding_count: 0, error: "Coin unavailable" });
  });

  it("adds a fully valued Coin sleeve without changing legacy equity NAV", async () => {
    kite.getKiteMutualFundHoldings.mockResolvedValue({
      ok: true,
      data: [{ tradingsymbol: "INF123", fund: "Example Fund", quantity: 10, average_price: 50, last_price: 60 }],
    });
    const { GET } = await import("@/app/api/kite/portfolio/route");
    const body = await (await GET()).json();

    expect(body.nav).toBe(1240);
    expect(body.combined_nav).toBe(1840);
    expect(body.coin).toMatchObject({
      available: true,
      holding_count: 1,
      valuation_complete: true,
      total_invested: 500,
      total_value: 600,
      total_pnl: 100,
    });
  });

  it("withholds combined NAV when any Coin holding lacks valuation", async () => {
    kite.getKiteMutualFundHoldings.mockResolvedValue({
      ok: true,
      data: [{ tradingsymbol: "INF123", fund: "Example Fund", quantity: 10, average_price: 50, last_price: null }],
    });
    const { GET } = await import("@/app/api/kite/portfolio/route");
    const body = await (await GET()).json();

    expect(body.coin.available).toBe(true);
    expect(body.coin.valuation_complete).toBe(false);
    expect(body.coin.total_value).toBeNull();
    expect(body.combined_nav).toBeNull();
  });

  it("treats a successful empty Coin account as available", async () => {
    kite.getKiteMutualFundHoldings.mockResolvedValue({ ok: true, data: [] });
    const { GET } = await import("@/app/api/kite/portfolio/route");
    const body = await (await GET()).json();

    expect(body.coin).toMatchObject({ available: true, holding_count: 0, valuation_complete: true, total_value: 0 });
    expect(body.combined_nav).toBe(1240);
  });
});
