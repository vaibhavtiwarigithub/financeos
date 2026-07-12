import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  creds: vi.fn(), token: vi.fn(), place: vi.fn(), get: vi.fn(), del: vi.fn(),
}));
vi.mock("@/lib/kite", () => ({
  getKiteCreds: (...a: any[]) => h.creds(...a),
  getAccessToken: (...a: any[]) => h.token(...a),
  placeEquityOrder: (...a: any[]) => h.place(...a),
  kiteGet: (...a: any[]) => h.get(...a),
  kiteDelete: (...a: any[]) => h.del(...a),
}));

import { kiteAdapter } from "@/lib/brokers/adapters/kite";

describe("Kite adapter lifecycle", () => {
  beforeEach(() => Object.values(h).forEach(fn => fn.mockReset()));

  it("requires both credentials and a fresh daily session", async () => {
    h.creds.mockResolvedValue({ apiKey: "k", apiSecret: "s" });
    h.token.mockResolvedValue({ fresh: false });
    expect(await kiteAdapter().isConfigured()).toBe(false);
  });

  it("rejects paper mode without touching Kite", async () => {
    const result = await kiteAdapter().submitOrder({ env: "paper", symbol: "RELIANCE", side: "buy", qty: 1, type: "market" });
    expect(result.ok).toBe(false);
    expect(h.place).not.toHaveBeenCalled();
  });

  it("maps a live limit order deterministically", async () => {
    h.place.mockResolvedValue({ ok: true, data: { order_id: "kite-1" } });
    const result = await kiteAdapter().submitOrder({ env: "live", symbol: "RELIANCE", side: "sell", qty: 3, type: "limit", limitPrice: 2500 });
    expect(result).toMatchObject({ ok: true, brokerOrderId: "kite-1" });
    expect(h.place).toHaveBeenCalledWith(expect.objectContaining({ transaction_type: "SELL", quantity: 3, order_type: "LIMIT", price: 2500 }));
  });

  it("maps partial fill quantities and prices from the latest history state", async () => {
    h.get.mockResolvedValue({ ok: true, data: [
      { status: "OPEN", filled_quantity: 0 },
      { status: "OPEN", filled_quantity: 2, average_price: 2488.5 },
    ] });
    expect(await kiteAdapter().getOrder("kite-1", "live")).toMatchObject({
      ok: true, status: "partially_filled", filledQty: 2, avgFillPrice: 2488.5,
    });
  });

  it("propagates cancellation rejection", async () => {
    h.del.mockResolvedValue({ ok: false, error: "order already complete" });
    expect(await kiteAdapter().cancelOrder("kite-1", "live")).toEqual({ ok: false, error: "order already complete" });
  });
});
