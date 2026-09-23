import { describe, it, expect } from "vitest";
import { evaluateLeveragedLiveEntry, LEVERAGED_LIVE_MIN_PAPER_TRADES } from "./leveraged-live-kernel";

const BASE = {
  deploymentFlagEnabled: true,
  liveAutoEnabled: true,
  liveAutoEnabledUntil: null,
  appPaused: false,
  securityLocked: false,
  tradingEnabledUs: true,
  protectiveOrdersEnabled: true,
  protectivePlacementWorkerAvailable: true,
  leaseUsd: 200,
  closedPaperTradeCount: LEVERAGED_LIVE_MIN_PAPER_TRADES,
  minPaperTradesOverride: false,
  openUnresolvedCriticalAlertCount: 0,
  now: 1_000_000,
};

describe("evaluateLeveragedLiveEntry", () => {
  it("passes when every gate clears", () => {
    expect(evaluateLeveragedLiveEntry(BASE)).toEqual({ go: true });
  });
  it("fails closed on the deployment flag", () => {
    expect(evaluateLeveragedLiveEntry({ ...BASE, deploymentFlagEnabled: false })).toMatchObject({ go: false, gate: "deployment_flag_inactive" });
  });
  it("fails closed on the DB toggle", () => {
    expect(evaluateLeveragedLiveEntry({ ...BASE, liveAutoEnabled: false })).toMatchObject({ go: false, gate: "db_toggle_off" });
  });
  it("fails closed on an expired lease window", () => {
    expect(evaluateLeveragedLiveEntry({ ...BASE, liveAutoEnabledUntil: "1970-01-01T00:00:00.000Z" })).toMatchObject({ go: false, gate: "lease_expired" });
  });
  it("fails closed on app_paused / security_locked / trading_disabled_us", () => {
    expect(evaluateLeveragedLiveEntry({ ...BASE, appPaused: true })).toMatchObject({ go: false, gate: "app_paused" });
    expect(evaluateLeveragedLiveEntry({ ...BASE, securityLocked: true })).toMatchObject({ go: false, gate: "security_locked" });
    expect(evaluateLeveragedLiveEntry({ ...BASE, tradingEnabledUs: false })).toMatchObject({ go: false, gate: "trading_disabled_us" });
  });
  it("REFUSES to go live without the protective-stop worker enabled — this is the non-negotiable", () => {
    expect(evaluateLeveragedLiveEntry({ ...BASE, protectivePlacementWorkerAvailable: false })).toMatchObject({ go: false, gate: "protective_worker_unavailable" });
    expect(evaluateLeveragedLiveEntry({ ...BASE, protectiveOrdersEnabled: false })).toMatchObject({ go: false, gate: "protective_orders_disabled" });
  });
  it("fails closed when the lease is zero or unset (the safe default)", () => {
    expect(evaluateLeveragedLiveEntry({ ...BASE, leaseUsd: 0 })).toMatchObject({ go: false, gate: "no_lease_capacity" });
    expect(evaluateLeveragedLiveEntry({ ...BASE, leaseUsd: NaN })).toMatchObject({ go: false, gate: "no_lease_capacity" });
    expect(evaluateLeveragedLiveEntry({ ...BASE, leaseUsd: -5 })).toMatchObject({ go: false, gate: "no_lease_capacity" });
  });
  it("acts as a kill switch on any open unresolved critical alert", () => {
    expect(evaluateLeveragedLiveEntry({ ...BASE, openUnresolvedCriticalAlertCount: 1 })).toMatchObject({ go: false, gate: "open_critical_alerts" });
  });
  it("blocks a symbol below the paper-evidence floor unless explicitly overridden", () => {
    expect(evaluateLeveragedLiveEntry({ ...BASE, closedPaperTradeCount: 9 })).toMatchObject({ go: false, gate: "insufficient_paper_evidence" });
    expect(evaluateLeveragedLiveEntry({ ...BASE, closedPaperTradeCount: 0, minPaperTradesOverride: true })).toEqual({ go: true });
  });
});
