import { beforeEach, describe, expect, it, vi } from "vitest";
import { RH_ORDER_ACCOUNT_ID, rhCancelOrder, rhGetOrder, rhPlaceMarketOrder } from "@/lib/brokers/robinhood/rest-client";

function svcWithToken() {
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: { key_value: JSON.stringify({ access_token: "token" }) } }),
  };
  return { from: () => chain } as any;
}

describe("Robinhood REST deterministic lifecycle", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));

  it("rejects every account except the agentic account before any network call", async () => {
    const result = await rhPlaceMarketOrder(svcWithToken(), { symbol: "AAPL", qty: 1, side: "buy", account: "965848641" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/permitted agentic account/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("submits exactly once to the permitted account and returns the broker id", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [{ url: "https://api.robinhood.com/instruments/a/" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "order-1" }), { status: 201 }));
    const result = await rhPlaceMarketOrder(svcWithToken(), { symbol: "AAPL", qty: 2, side: "buy", account: RH_ORDER_ACCOUNT_ID });
    expect(result).toMatchObject({ ok: true, order_id: "order-1" });
    expect(fetch).toHaveBeenCalledTimes(2);
    const submitBody = String(vi.mocked(fetch).mock.calls[1][1]?.body);
    expect(submitBody).toContain(`accounts%2F${RH_ORDER_ACCOUNT_ID}%2F`);
  });

  it("treats a network failure after submit as ambiguous and never as safe-to-retry", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [{ url: "https://api.robinhood.com/instruments/a/" }] }), { status: 200 }))
      .mockRejectedValueOnce(new Error("connection reset"));
    const result = await rhPlaceMarketOrder(svcWithToken(), { symbol: "AAPL", qty: 1, side: "buy" });
    expect(result).toMatchObject({ ok: false, needs_reconcile: true });
  });

  it("maps partial fills with exact cumulative quantity and average price", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      state: "partially_filled", cumulative_quantity: "3", average_price: "101.25",
    }), { status: 200 }));
    expect(await rhGetOrder(svcWithToken(), "order-1")).toMatchObject({
      ok: true, status: "partially_filled", filledQty: 3, avgFillPrice: 101.25,
    });
  });

  it("reports cancel failures rather than claiming success", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("cannot cancel", { status: 409 }));
    const result = await rhCancelOrder(svcWithToken(), "order-1");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/409/);
  });
});
