import { describe, expect, it } from "vitest";
import { capability, capabilityUsable, unsupportedCapability } from "@/lib/brokers/preflight";

const input = { accountId: "acct-1", symbol: "AAPL", side: "buy" as const, qty: 2, type: "market" as const, env: "live" as const };

describe("broker instrument preflight contract", () => {
  it("accepts only fresh, exact, active, side-authorized evidence", () => {
    const c = capability(input, { broker: "alpaca", market: "us", source: "asset", allowed: true, active: true, buyAllowed: true, sellAllowed: true, lotSize: 1, raw: { id: "a" } });
    expect(capabilityUsable(c, input)).toEqual({ ok: true });
    expect(capabilityUsable({ ...c, buyAllowed: false }, input)).toEqual({ ok: false, reason: "buy_not_allowed" });
    expect(capabilityUsable({ ...c, accountId: "wrong" }, input)).toEqual({ ok: false, reason: "broker_context_mismatch" });
  });

  it("treats sell permission independently from buy permission", () => {
    const sell = { ...input, side: "sell" as const };
    const c = capability(sell, { broker: "alpaca", market: "us", source: "asset", allowed: true, active: true, buyAllowed: false, sellAllowed: true, closeOnly: true, lotSize: 1 });
    expect(capabilityUsable(c, sell)).toEqual({ ok: true });
  });

  it("rejects unsupported, expired, wrong-lot, and context-shifted evidence", () => {
    expect(capabilityUsable(unsupportedCapability("robinhood_mcp", "us", input, "unsupported"), input).ok).toBe(false);
    const c = capability(input, { broker: "kite", market: "india", source: "master", allowed: true, active: true, buyAllowed: true, lotSize: 5 });
    expect(capabilityUsable(c, input)).toEqual({ ok: false, reason: "invalid_lot_size" });
    expect(capabilityUsable({ ...c, lotSize: 1, expiresAt: "2020-01-01T00:00:00.000Z" }, input).ok).toBe(false);
    expect(capabilityUsable({ ...c, lotSize: 1 }, { ...input, symbol: "MSFT" }).ok).toBe(false);
  });
});
