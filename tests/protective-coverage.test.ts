import { describe, expect, it } from "vitest";
import {
  evaluateAutonomousEntryProtection,
  evaluateProtectionCoverage,
  managedLivePositionId,
  type ManagedLivePosition,
  type ProtectiveOrderCoverageRow,
} from "@/lib/protective/coverage";

const position: ManagedLivePosition = {
  market: "india",
  broker: "kite",
  brokerAccountId: "kite-1",
  symbol: "RELIANCE.NS",
  qty: 10,
};

function row(overrides: Partial<ProtectiveOrderCoverageRow> = {}): ProtectiveOrderCoverageRow {
  return {
    position_id: managedLivePositionId(position),
    broker: "kite",
    broker_account_id: "kite-1",
    market: "india",
    symbol: "RELIANCE",
    protected_qty: 10,
    reconciled_held_qty: 10,
    status: "active",
    broker_order_id: null,
    kite_trigger_id: "gtt-1",
    expiry: "2027-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("protective coverage control plane", () => {
  it("uses an account-local stable key and normalizes India quote suffixes", () => {
    expect(managedLivePositionId(position)).toBe("india:kite:kite-1:RELIANCE");
  });

  it("requires one active, unexpired, full-quantity broker-proven floor", () => {
    const coverage = evaluateProtectionCoverage({
      positions: [position],
      protectiveOrders: [row()],
      now: new Date("2026-07-30T00:00:00.000Z"),
    });
    expect(coverage.protected).toBe(true);
    expect(coverage.findings[0]).toMatchObject({ protected: true, symbol: "RELIANCE.NS" });
  });

  it("does not combine partial rows into a falsely protected position", () => {
    const coverage = evaluateProtectionCoverage({
      positions: [position],
      protectiveOrders: [row({ protected_qty: 5, reconciled_held_qty: 10 })],
      now: new Date("2026-07-30T00:00:00.000Z"),
    });
    expect(coverage.protected).toBe(false);
    expect(coverage.findings[0].reason).toMatch(/exactly match/);
  });

  it("rejects an oversized stale stop that could sell more than is currently held", () => {
    const coverage = evaluateProtectionCoverage({
      positions: [{ ...position, qty: 5 }],
      protectiveOrders: [row({ protected_qty: 10, reconciled_held_qty: 10 })],
      now: new Date("2026-07-30T00:00:00.000Z"),
    });
    expect(coverage.protected).toBe(false);
    expect(coverage.findings[0].reason).toMatch(/exactly match/);
  });

  it("fails closed for terminal, expired, or malformed active broker state", () => {
    const now = new Date("2026-07-30T00:00:00.000Z");
    for (const protectiveOrder of [
      row({ status: "needs_reconcile" }),
      row({ expiry: "2026-07-29T00:00:00.000Z" }),
      row({ broker_order_id: "order-1", kite_trigger_id: "gtt-1" }),
    ]) {
      expect(evaluateProtectionCoverage({ positions: [position], protectiveOrders: [protectiveOrder], now }).protected).toBe(false);
    }
  });

  it("blocks autonomous entries when the feature is off, the worker is absent, or coverage is missing", () => {
    const covered = evaluateProtectionCoverage({
      positions: [position], protectiveOrders: [row()], now: new Date("2026-07-30T00:00:00.000Z"),
    });
    expect(evaluateAutonomousEntryProtection({ placementEnabled: false, placementWorkerAvailable: true, coverage: covered })).toMatchObject({ ok: false, reason: "protective_orders_enabled=false" });
    expect(evaluateAutonomousEntryProtection({ placementEnabled: true, placementWorkerAvailable: false, coverage: covered })).toMatchObject({ ok: false, reason: "protective placement worker is not implemented" });
    expect(evaluateAutonomousEntryProtection({
      placementEnabled: true,
      placementWorkerAvailable: true,
      coverage: { protected: false, findings: [{ positionId: "us:robinhood:a:ABC", market: "us", symbol: "ABC", protected: false, reason: "missing" }] },
    })).toMatchObject({ ok: false, reason: expect.stringContaining("unprotected managed") });
  });

  it("blocks an explicit unknown aggregate even when no per-position finding was produced", () => {
    expect(evaluateAutonomousEntryProtection({
      placementEnabled: true,
      placementWorkerAvailable: true,
      coverage: { protected: false, findings: [] },
    })).toMatchObject({
      ok: false,
      reason: "protective coverage is unknown or internally inconsistent",
    });
  });
});
