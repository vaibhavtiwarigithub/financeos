import { describe, it, expect } from "vitest";
import { evaluateCryptoLiveEntry, CRYPTO_LIVE_MIN_PAPER_TRADES } from "./crypto-live-kernel";

const BASE = {
  deploymentFlagEnabled: true,
  liveAutoEnabled: true,
  appPaused: false,
  securityLocked: false,
  leaseUsd: 50,
  closedPaperTradeCount: CRYPTO_LIVE_MIN_PAPER_TRADES,
  minPaperTradesOverride: false,
  openUnresolvedCriticalAlertCount: 0,
  robinhoodCryptoAccountEligible: true,
};

describe("evaluateCryptoLiveEntry", () => {
  it("passes when every gate clears", () => {
    expect(evaluateCryptoLiveEntry(BASE)).toEqual({ go: true });
  });
  it("fails closed on the deployment flag and DB toggle", () => {
    expect(evaluateCryptoLiveEntry({ ...BASE, deploymentFlagEnabled: false })).toMatchObject({ go: false, gate: "deployment_flag_inactive" });
    expect(evaluateCryptoLiveEntry({ ...BASE, liveAutoEnabled: false })).toMatchObject({ go: false, gate: "db_toggle_off" });
  });
  it("fails closed on app_paused / security_locked", () => {
    expect(evaluateCryptoLiveEntry({ ...BASE, appPaused: true })).toMatchObject({ go: false, gate: "app_paused" });
    expect(evaluateCryptoLiveEntry({ ...BASE, securityLocked: true })).toMatchObject({ go: false, gate: "security_locked" });
  });
  it("requires a real, current Robinhood crypto account eligibility check", () => {
    expect(evaluateCryptoLiveEntry({ ...BASE, robinhoodCryptoAccountEligible: false })).toMatchObject({ go: false, gate: "crypto_account_not_eligible" });
  });
  it("fails closed when the lease is zero or unset (the safe default)", () => {
    expect(evaluateCryptoLiveEntry({ ...BASE, leaseUsd: 0 })).toMatchObject({ go: false, gate: "no_lease_capacity" });
    expect(evaluateCryptoLiveEntry({ ...BASE, leaseUsd: NaN })).toMatchObject({ go: false, gate: "no_lease_capacity" });
  });
  it("acts as a kill switch on any open unresolved critical alert", () => {
    expect(evaluateCryptoLiveEntry({ ...BASE, openUnresolvedCriticalAlertCount: 1 })).toMatchObject({ go: false, gate: "open_critical_alerts" });
  });
  it("blocks a symbol below the paper-evidence floor unless explicitly overridden", () => {
    expect(evaluateCryptoLiveEntry({ ...BASE, closedPaperTradeCount: 9 })).toMatchObject({ go: false, gate: "insufficient_paper_evidence" });
    expect(evaluateCryptoLiveEntry({ ...BASE, closedPaperTradeCount: 0, minPaperTradesOverride: true })).toEqual({ go: true });
  });
});
