// webull_trade — order lifecycle against a FIXTURE transport (no network).
// Covers Failure Tests 8 (dup client_order_id), 9 (timeout/malformed → reconcile),
// 10 (partial fills), and the "no order id → needs_reconcile" rule.
import { describe, it, expect } from "vitest";
import {
  placeOrder,
  queryOrder,
  cancelOrder,
  reconcileByClientOrderId,
  serializeOrderBody,
  mapWebullStatus,
} from "@/lib/brokers/webull-trade/lifecycle";
import type { WebullTransport, TransportResult, TransportRequest } from "@/lib/brokers/webull-trade/transport";
import { deriveClientOrderId, isValidClientOrderId } from "@/lib/brokers/webull-trade/client-order-id";
import type { WebullNormalizedOrder } from "@/lib/brokers/webull-trade/types";

const ORDER: WebullNormalizedOrder = {
  accountId: "WBACCT1",
  symbol: "AAPL",
  side: "BUY",
  orderType: "MARKET",
  qty: 2,
  timeInForce: "DAY",
  session: "CORE",
  clientOrderId: "kai0abc",
};

// A fixture transport that records the broker-side state keyed by client_order_id
// so we can prove idempotency (the same client id never creates a second order).
function fixtureBroker() {
  const byClientId = new Map<string, string>(); // clientOrderId -> brokerOrderId
  const calls: TransportRequest[] = [];
  let seq = 1;
  const transport: WebullTransport = {
    async send(req: TransportRequest): Promise<TransportResult> {
      calls.push(req);
      if (req.path.endsWith("/place")) {
        const body = JSON.parse(req.body ?? "{}");
        const cid = body.client_order_id;
        // Idempotent: a repeated client_order_id returns the SAME broker order id.
        let bid = byClientId.get(cid);
        if (!bid) { bid = `WB-ORD-${seq++}`; byClientId.set(cid, bid); }
        return { ok: true, status: 200, json: { data: { order_id: bid, client_order_id: cid } } };
      }
      if (req.path.endsWith("/query")) {
        const cid = req.query?.client_order_id as string | undefined;
        if (cid) {
          const bid = byClientId.get(cid);
          if (!bid) return { ok: true, status: 200, json: { data: {} } };
          return { ok: true, status: 200, json: { data: { order_id: bid, status: "Filled" } } };
        }
        return { ok: true, status: 200, json: { data: { order_id: req.query?.order_id, status: "PartiallyFilled", cumulative_quantity: 1, average_price: 190.25 } } };
      }
      if (req.path.endsWith("/cancel")) return { ok: true, status: 200, json: { data: { ok: true } } };
      return { ok: false, timeout: false, error: "unknown path" };
    },
  };
  return { transport, byClientId, calls };
}

describe("webull_trade lifecycle — place/query/cancel/reconcile", () => {
  it("places once and returns a tracked broker order id", async () => {
    const { transport, calls } = fixtureBroker();
    const r = await placeOrder(transport, ORDER, "sandbox");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.brokerOrderId).toMatch(/^WB-ORD-/);
    expect(calls.filter(c => c.path.endsWith("/place"))).toHaveLength(1);
  });

  it("serializeOrderBody carries client_order_id and no dollar-notional field for qty", () => {
    const body = JSON.parse(serializeOrderBody(ORDER));
    expect(body.quantity).toBe(2);
    expect(body.client_order_id).toBe("kai0abc");
    expect(body).not.toHaveProperty("amount");
    expect(body).not.toHaveProperty("notional");
  });

  it("a repeated client_order_id cannot create a second order (Test 8)", async () => {
    const { transport, byClientId } = fixtureBroker();
    const a = await placeOrder(transport, ORDER, "sandbox");
    const b = await placeOrder(transport, ORDER, "sandbox"); // same client id
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.brokerOrderId).toBe(b.brokerOrderId);
    expect(byClientId.size).toBe(1); // one broker order for one client id
  });

  it("a timeout on place → needsReconcile, never success, never blind resubmit (Test 9)", async () => {
    const transport: WebullTransport = { async send() { return { ok: false, timeout: true, error: "request timed out" }; } };
    const r = await placeOrder(transport, ORDER, "sandbox");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.needsReconcile).toBe(true);
  });

  it("a place throwing after possible send → needsReconcile", async () => {
    const transport: WebullTransport = { async send() { throw new Error("socket hang up"); } };
    const r = await placeOrder(transport, ORDER, "sandbox");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.needsReconcile).toBe(true);
  });

  it("a 200 with NO parseable order id → needsReconcile (not success)", async () => {
    const transport: WebullTransport = { async send() { return { ok: true, status: 200, json: { data: { message: "accepted" } } }; } };
    const r = await placeOrder(transport, ORDER, "sandbox");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.needsReconcile).toBe(true);
  });

  it("a definite HTTP rejection is a clean (non-reconcile) failure", async () => {
    const transport: WebullTransport = { async send() { return { ok: false, timeout: false, error: "400 invalid symbol" }; } };
    const r = await placeOrder(transport, ORDER, "sandbox");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.needsReconcile).toBe(false);
  });

  it("query maps a partial fill with exact cumulative qty and avg price (Test 10)", async () => {
    const { transport } = fixtureBroker();
    const s = await queryOrder(transport, "WB-ORD-9", "sandbox");
    expect(s).toMatchObject({ ok: true, status: "partially_filled", filledQty: 1, avgFillPrice: 190.25 });
  });

  it("query failure → needs_reconcile, never a fabricated terminal state", async () => {
    const transport: WebullTransport = { async send() { return { ok: false, timeout: true, error: "timeout" }; } };
    const s = await queryOrder(transport, "WB-ORD-1", "sandbox");
    expect(s.ok).toBe(false);
    expect(s.status).toBe("needs_reconcile");
  });

  it("reconcileByClientOrderId FINDS a landed order (proves the ambiguous submit did land → never resubmit)", async () => {
    const { transport } = fixtureBroker();
    await placeOrder(transport, ORDER, "sandbox"); // lands under kai0abc
    const r = await reconcileByClientOrderId(transport, "kai0abc", "sandbox");
    expect(r.found).toBe(true);
    expect(r.brokerOrderId).toMatch(/^WB-ORD-/);
  });

  it("reconcileByClientOrderId reports NOT-found when the submit never landed", async () => {
    const { transport } = fixtureBroker();
    const r = await reconcileByClientOrderId(transport, "kai-never", "sandbox");
    expect(r.ok).toBe(true);
    expect(r.found).toBe(false);
  });

  it("cancel reports success and failure honestly", async () => {
    const { transport } = fixtureBroker();
    expect(await cancelOrder(transport, "WB-ORD-1", "sandbox")).toEqual({ ok: true });
    const failing: WebullTransport = { async send() { return { ok: false, timeout: false, error: "409 cannot cancel" }; } };
    const r = await cancelOrder(failing, "WB-ORD-1", "sandbox");
    expect(r.ok).toBe(false);
  });

  it("status mapping is tolerant and never misreports unknown as terminal", () => {
    expect(mapWebullStatus("PartiallyFilled")).toBe("partially_filled");
    expect(mapWebullStatus("Filled")).toBe("filled");
    expect(mapWebullStatus("Cancelled")).toBe("canceled");
    expect(mapWebullStatus("Rejected")).toBe("rejected");
    expect(mapWebullStatus("Expired")).toBe("expired");
    expect(mapWebullStatus("Working")).toBe("submitted");
    expect(mapWebullStatus("")).toBe("submitted");
  });
});

describe("webull_trade client_order_id", () => {
  it("is deterministic, <=32 chars, alphanumeric, and stable per intent", () => {
    const a = deriveClientOrderId("intent-123");
    const b = deriveClientOrderId("intent-123");
    expect(a).toBe(b);
    expect(a.length).toBeLessThanOrEqual(32);
    expect(isValidClientOrderId(a)).toBe(true);
  });

  it("differs across intents", () => {
    expect(deriveClientOrderId("intent-a")).not.toBe(deriveClientOrderId("intent-b"));
  });

  it("carries no account/symbol PII (only a fixed prefix + hash)", () => {
    const id = deriveClientOrderId("WBACCT1|AAPL|BUY|2");
    expect(id.startsWith("kai")).toBe(true);
    expect(id).not.toContain("WBACCT1");
    expect(id).not.toContain("AAPL");
  });

  it("throws on empty intent", () => {
    expect(() => deriveClientOrderId("")).toThrow();
  });
});
