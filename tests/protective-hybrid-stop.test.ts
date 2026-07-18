import { describe, expect, it } from "vitest";
import {
  BrokerProtectiveCapabilities,
  evaluateProtection,
  ProtectionRequest,
} from "@/lib/protective/capabilities";
import { KITE_PROTECTIVE_CAPABILITIES } from "@/lib/protective/kite-capabilities";
import { computeDisasterFloor } from "@/lib/protective/disaster-floor";
import { reconcileProtectiveOrder } from "@/lib/protective/reconcile";
import {
  canSubmitCompetingSell,
  canTransition,
  includedInPnlAndRisk,
  includedInSignalWeightLearning,
  isTerminal,
  learningScopeForExit,
  PROTECTIVE_EXIT_REASON,
  totalExecutableSellExceedsHeld,
} from "@/lib/protective/state";
import { planProtectivePlacement, protectivePlacementAllowed } from "@/lib/protective/placement-gate";

// A multi-day, regular-session, CNC India equity request (the Kite disaster-floor case).
const kiteReq: ProtectionRequest = {
  market: "india",
  instrumentType: "equity",
  accountMode: "cnc",
  side: "sell_long",
  minLifetimeDays: 30,
  session: "regular",
};

describe("hybrid-stop capability matrix", () => {
  it("Kite: multi-day protection resolves to the WEAKER gtt_limit (never a stop-market floor)", () => {
    const e = evaluateProtection(KITE_PROTECTIVE_CAPABILITIES, kiteReq);
    expect(e.protectedByBroker).toBe(true);
    if (!e.protectedByBroker) return;
    expect(e.kind).toBe("gtt_limit");
    expect(e.strength).toBe("weaker_limit");
    // The declared DAY-only stop_market is rejected as a multi-day floor.
    expect(e.rejected.some((r) => r.kind === "stop_market")).toBe(true);
    // Honesty caveat about unfilled-trigger risk must be present.
    expect(e.caveats.join(" ")).toMatch(/MAY NEVER FILL/i);
  });

  // Acceptance 12 — no eligible multi-day order → unprotected-by-broker, never silent.
  it("AT12: an adapter with only a DAY stop-market is unprotected-by-broker for a multi-day floor", () => {
    const dayOnly: BrokerProtectiveCapabilities = {
      broker: "dayonly",
      scope: { market: "india", instrumentTypes: ["equity"], sides: ["sell_long"], accountModes: ["cnc"] },
      orders: {
        stop_market: { timeInForce: ["day"], sessions: ["regular"], updateMode: "cancel_replace", maxLifetimeDays: 1, oco: false },
      },
    };
    const e = evaluateProtection(dayOnly, kiteReq);
    expect(e.protectedByBroker).toBe(false);
    if (e.protectedByBroker) return;
    expect(e.unprotectedByBroker).toBe(true);
    expect(e.reason).toMatch(/synthetic-only|multi-day/i);
    expect(e.rejected.some((r) => r.kind === "stop_market" && /multi-day|DAY/i.test(r.reason))).toBe(true);
  });

  // Acceptance 13 — reject unsupported order-type/TIF/session/account combos.
  it("AT13: GTC alone never implies extended-hours triggering (session is separate from TIF)", () => {
    const gtcRegularOnly: BrokerProtectiveCapabilities = {
      broker: "gtc",
      scope: { market: "us", instrumentTypes: ["equity"], sides: ["sell_long"], accountModes: ["cash"] },
      orders: {
        stop_market: { timeInForce: ["gtc"], sessions: ["regular"], updateMode: "cancel_replace", maxLifetimeDays: null, oco: false },
      },
    };
    const extendedReq: ProtectionRequest = {
      market: "us", instrumentType: "equity", accountMode: "cash", side: "sell_long", minLifetimeDays: 5, session: "extended",
    };
    const e = evaluateProtection(gtcRegularOnly, extendedReq);
    expect(e.protectedByBroker).toBe(false);
    if (e.protectedByBroker) return;
    expect(e.rejected.some((r) => r.kind === "stop_market" && /extended/i.test(r.reason))).toBe(true);
  });

  it("AT13: account-mode mismatch is rejected as out-of-scope", () => {
    const marginReq: ProtectionRequest = { ...kiteReq, accountMode: "margin" };
    const e = evaluateProtection(KITE_PROTECTIVE_CAPABILITIES, marginReq);
    expect(e.protectedByBroker).toBe(false);
  });

  // Acceptance 9 — US and India fixtures cannot cross.
  it("AT9: a US request cannot be protected by the India (Kite) adapter and vice-versa", () => {
    const usReq: ProtectionRequest = { ...kiteReq, market: "us" };
    const e = evaluateProtection(KITE_PROTECTIVE_CAPABILITIES, usReq);
    expect(e.protectedByBroker).toBe(false);
    if (e.protectedByBroker) return;
    expect(e.reason).toMatch(/out of broker scope/i);
  });
});

describe("hybrid-stop disaster-floor calculator", () => {
  it("default wider mode places the floor strictly BELOW the analytical stop", () => {
    const r = computeDisasterFloor({
      mode: "wider_disaster_floor",
      analyticalStop: 100,
      highWaterMark: 120,
      distance: { kind: "percent_beyond_stop", pct: 0.05 },
    });
    expect(r.ok).toBe(true);
    expect(r.floor).toBeCloseTo(95, 6);
    expect(r.belowAnalyticalStop).toBe(true);
  });

  it("does not hardcode a distance — an invalid/too-small distance fails, not defaults", () => {
    const r = computeDisasterFloor({
      mode: "wider_disaster_floor",
      analyticalStop: 100,
      highWaterMark: 120,
      distance: { kind: "percent_beyond_stop", pct: 0 }, // zero → floor == stop, not below
    });
    expect(r.ok).toBe(false);
    expect(r.floor).toBeNull();
  });

  // Acceptance 3 — a falling high-water mark cannot lower the floor.
  it("AT3: a falling high-water mark can never lower the floor (monotonic ratchet)", () => {
    const first = computeDisasterFloor({
      mode: "wider_disaster_floor",
      analyticalStop: 100,
      highWaterMark: 130,
      distance: { kind: "fixed_offset", offset: 5 },
    });
    expect(first.floor).toBe(95);
    // HWM falls → analytical stop falls to 80 → candidate floor 75. currentFloor 95 holds.
    const second = computeDisasterFloor({
      mode: "wider_disaster_floor",
      analyticalStop: 80,
      highWaterMark: 90, // fell
      distance: { kind: "fixed_offset", offset: 5 },
      currentFloor: 95,
    });
    expect(second.ok).toBe(false);
    expect(second.floor).toBeNull();
    expect(second.reason).toMatch(/no longer wider/i);
  });

  it("ratchets UP when the analytical stop rises", () => {
    const r = computeDisasterFloor({
      mode: "wider_disaster_floor",
      analyticalStop: 110,
      highWaterMark: 140,
      distance: { kind: "fixed_offset", offset: 5 },
      currentFloor: 95,
    });
    expect(r.floor).toBe(105);
    expect(r.changed).toBe(true);
    expect(r.raisedFrom).toBe(95);
  });

  it("hard max-loss bound raises (never lowers) the floor and reduces risk", () => {
    const r = computeDisasterFloor({
      mode: "wider_disaster_floor",
      analyticalStop: 100,
      highWaterMark: 120,
      distance: { kind: "percent_beyond_stop", pct: 0.2 }, // candidate 80
      hardMaxLossFloor: 90, // owner's max-loss price is tighter
    });
    expect(r.floor).toBe(90);
  });

  it("wider_disaster_floor reason string confirms outage+catastrophic-loss intent", () => {
    const r = computeDisasterFloor({
      mode: "wider_disaster_floor",
      analyticalStop: 100,
      highWaterMark: 120,
      distance: { kind: "fixed_offset", offset: 5 },
    });
    expect(r.floor).toBe(95);
    expect(r.reason).toMatch(/outage \+ catastrophic-loss mitigation/i);
  });

  it("rejects a legacy DB/JSON mode and a hard bound at the analytical stop", () => {
    const base = { analyticalStop: 100, highWaterMark: 120, distance: { kind: "fixed_offset" as const, offset: 5 } };
    expect(computeDisasterFloor({ ...base, mode: "touch_at_analytical_stop" as any }).ok).toBe(false);
    expect(computeDisasterFloor({ ...base, mode: "wider_disaster_floor", hardMaxLossFloor: 100 }).ok).toBe(false);
  });
});

describe("hybrid-stop reconciliation loop", () => {
  const baseInput = {
    symbol: "RELIANCE",
    brokerAccountId: "kite-acct",
    orderKind: "gtt_limit" as const,
    priorProtectedQty: 10,
    priorStatus: "active" as const,
    now: "2026-07-18T10:00:00Z",
  };

  // Acceptance 4 — Kite trigger with no fill stays open/unprotected + raises issue.
  it("AT4: a gtt_limit trigger with NO fill stays open, reports unprotected, raises a critical issue", () => {
    const r = reconcileProtectiveOrder({ ...baseInput, snapshot: { found: true, status: "triggered", filledQty: 0 } });
    expect(r.positionClosed).toBe(false);
    expect(r.status).toBe("triggered");
    expect(r.issues.some((i) => i.severity === "critical" && /not filled|unprotected/i.test(i.detail))).toBe(true);
  });

  // Acceptance 5 — out-of-band fill reconciles with actual quantity and price.
  it("AT5: a confirmed fill closes with actual qty and protective_disaster_floor provenance", () => {
    const r = reconcileProtectiveOrder({ ...baseInput, snapshot: { found: true, status: "filled", filledQty: 10, avgFillPrice: 92.5 } });
    expect(r.positionClosed).toBe(true);
    expect(r.closeQty).toBe(10);
    expect(r.closeExitReason).toBe(PROTECTIVE_EXIT_REASON);
    expect(r.learningScope).toBe("risk_policy_only");
  });

  it("a filled status without confirmed positive quantity never closes the book", () => {
    for (const filledQty of [undefined, 0, Number.NaN, 11]) {
      const r = reconcileProtectiveOrder({ ...baseInput, snapshot: { found: true, status: "filled", filledQty } });
      expect(r.positionClosed).toBe(false);
      expect(r.status).toBe("needs_reconcile");
      expect(r.unresolved).toBe(true);
    }
  });

  // Acceptance 6 — partial fills leave the correct residual protection.
  it("AT6: a partial fill leaves the correct residual and flags replacement", () => {
    const r = reconcileProtectiveOrder({ ...baseInput, snapshot: { found: true, status: "partially_filled", filledQty: 4, heldQty: 6 } });
    expect(r.closeQty).toBe(4);
    expect(r.residualProtectedQty).toBe(6);
    expect(r.needsReplacement).toBe(true);
    expect(r.residualProtectedQty).toBeLessThanOrEqual(6); // never exceeds held
  });

  // Acceptance 7 — expiry and broker-side cancellation are detected.
  it("AT7: expiry is detected as a critical health state", () => {
    const r = reconcileProtectiveOrder({ ...baseInput, snapshot: { found: true, status: "expired", heldQty: 10 } });
    expect(r.status).toBe("canceled");
    expect(r.needsReplacement).toBe(true);
    expect(r.issues.some((i) => i.severity === "critical" && /expired/i.test(i.title))).toBe(true);
  });

  it("AT7: a broker-side cancel while still held is detected and flagged unprotected", () => {
    const r = reconcileProtectiveOrder({ ...baseInput, snapshot: { found: true, status: "canceled", heldQty: 10 } });
    expect(r.status).toBe("canceled");
    expect(r.needsReplacement).toBe(true);
    expect(r.issues.some((i) => i.severity === "critical")).toBe(true);
  });

  it("a read failure never assumes state — needs_reconcile, unresolved", () => {
    const r = reconcileProtectiveOrder({ ...baseInput, snapshot: { found: true, snapshotError: "timeout" } });
    expect(r.status).toBe("needs_reconcile");
    expect(r.unresolved).toBe(true);
    expect(r.residualProtectedQty).toBe(10); // keeps prior, does not zero it
  });

  it("a not-found order is needs_reconcile, never assumed canceled", () => {
    const r = reconcileProtectiveOrder({ ...baseInput, snapshot: { found: false, heldQty: 10 } });
    expect(r.status).toBe("needs_reconcile");
    expect(r.needsReplacement).toBe(true);
  });

  // Acceptance 14 — split/corp-action cannot leave residual above held.
  it("AT14: a split/held-qty drift clamps residual to held and forces needs_reconcile", () => {
    const r = reconcileProtectiveOrder({ ...baseInput, priorProtectedQty: 10, snapshot: { found: true, status: "active", heldQty: 5 } });
    expect(r.status).toBe("needs_reconcile");
    expect(r.residualProtectedQty).toBeLessThanOrEqual(5);
    expect(r.issues.some((i) => /qty exceeds held/i.test(i.title))).toBe(true);
  });

  it("an active, in-window, matching-qty order reconciles clean", () => {
    const r = reconcileProtectiveOrder({ ...baseInput, snapshot: { found: true, status: "active", heldQty: 10, expiry: "2026-08-01T00:00:00Z" } });
    expect(r.status).toBe("active");
    expect(r.residualProtectedQty).toBe(10);
    expect(r.issues.length).toBe(0);
  });
});

describe("hybrid-stop long-only + cancel-before-replace", () => {
  // Acceptance 1 — a cancel failure prevents the explicit SELL.
  it("AT1: an unconfirmed cancellation blocks a competing SELL", () => {
    const r = canSubmitCompetingSell({
      reconciledHeldQty: 10,
      restingProtectiveQty: 10,
      restingCancellationConfirmed: false,
      requestedSellQty: 10,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/cancellation is NOT confirmed|accidental short/i);
  });

  it("AT1: a confirmed cancellation permits a full exit up to held qty", () => {
    const r = canSubmitCompetingSell({
      reconciledHeldQty: 10,
      restingProtectiveQty: 10,
      restingCancellationConfirmed: true,
      requestedSellQty: 10,
    });
    expect(r.ok).toBe(true);
  });

  // Acceptance 2 — a replace cannot create two executable protective orders.
  it("AT2: resting + competing SELL that exceeds held is rejected (no double protection)", () => {
    expect(
      totalExecutableSellExceedsHeld({ reconciledHeldQty: 10, restingProtectiveQty: 10, competingSellQty: 10 }),
    ).toBe(true);
    // Even WITH a confirmed cancel, a request above held is rejected.
    const r = canSubmitCompetingSell({
      reconciledHeldQty: 10,
      restingProtectiveQty: 0,
      restingCancellationConfirmed: true,
      requestedSellQty: 11,
    });
    expect(r.ok).toBe(false);
  });

  it("invalid numeric holdings/resting quantities fail closed", () => {
    expect(totalExecutableSellExceedsHeld({ reconciledHeldQty: Number.NaN, restingProtectiveQty: 0, competingSellQty: 1 })).toBe(true);
    expect(canSubmitCompetingSell({ reconciledHeldQty: 10, restingProtectiveQty: Number.NaN, restingCancellationConfirmed: true, requestedSellQty: 1 }).ok).toBe(false);
  });
});

describe("hybrid-stop exit provenance / learning attribution", () => {
  // Acceptance 11 — disaster-floor fill excluded from weight learning, present in P&L/risk.
  it("AT11: a protective_disaster_floor fill is excluded from weight learning but kept in P&L/risk", () => {
    const row = { exit_reason: PROTECTIVE_EXIT_REASON, learning_scope: "risk_policy_only" };
    expect(learningScopeForExit(PROTECTIVE_EXIT_REASON)).toBe("risk_policy_only");
    expect(includedInSignalWeightLearning(row)).toBe(false);
    expect(includedInPnlAndRisk(row)).toBe(true);
  });

  // Acceptance 10 — paper's existing close-based exits are untouched.
  it("AT10: ordinary exits stay 'full' scope and count in weight learning", () => {
    for (const reason of ["score_exit (68 < 37)", "target", "stop", "direction_flip (was long, now neutral)", null]) {
      expect(learningScopeForExit(reason)).toBe("full");
      expect(includedInSignalWeightLearning({ exit_reason: reason })).toBe(true);
    }
  });

  it("an unstamped legacy row (no scope, no reason) stays included", () => {
    expect(includedInSignalWeightLearning({})).toBe(true);
  });
});

describe("hybrid-stop status machine", () => {
  it("needs_reconcile is reachable from active; terminal states are terminal", () => {
    expect(canTransition("active", "needs_reconcile")).toBe(true);
    expect(canTransition("placing", "active")).toBe(true);
    expect(canTransition("filled", "active")).toBe(false);
    expect(isTerminal("filled")).toBe(true);
    expect(isTerminal("canceled")).toBe(true);
    expect(isTerminal("active")).toBe(false);
  });
});

describe("hybrid-stop placement gate (THE MONEY LINE — stays inert)", () => {
  const eligible = evaluateProtection(KITE_PROTECTIVE_CAPABILITIES, kiteReq);
  const floor = computeDisasterFloor({
    mode: "wider_disaster_floor",
    analyticalStop: 100,
    highWaterMark: 120,
    distance: { kind: "percent_beyond_stop", pct: 0.05 },
  });

  it("the flag is false by default and only an explicit true enables it", () => {
    expect(protectivePlacementAllowed(null)).toBe(false);
    expect(protectivePlacementAllowed(undefined)).toBe(false);
    expect(protectivePlacementAllowed({})).toBe(false);
    expect(protectivePlacementAllowed({ protective_orders_enabled: false })).toBe(false);
    expect(protectivePlacementAllowed({ protective_orders_enabled: null })).toBe(false);
    expect(protectivePlacementAllowed({ protective_orders_enabled: true })).toBe(true);
  });

  it("with the flag false the plan is ALWAYS inert (no broker action), even with valid inputs", () => {
    const plan = planProtectivePlacement({
      flag: { protective_orders_enabled: false },
      symbol: "RELIANCE",
      market: "india",
      brokerAccountId: "kite-acct",
      eligibility: eligible,
      floor,
      action: "place_floor",
      reconciledHeldQty: 10,
      desiredProtectQty: 10,
    });
    expect(plan.allowed).toBe(false);
    expect(plan.action).toBe("none");
    expect(plan.blockedBy.some((b) => /protective_orders_enabled is false/.test(b))).toBe(true);
  });

  // Acceptance 8 — an entry halt (placement disabled) cannot block an EXIT.
  it("AT8: the placement flag gates NEW protection, but the exit SELL gate is independent of it", () => {
    // Placement blocked while flag false…
    const plan = planProtectivePlacement({
      flag: { protective_orders_enabled: false },
      symbol: "RELIANCE", market: "india", brokerAccountId: "kite-acct",
      eligibility: eligible, floor, action: "place_floor", reconciledHeldQty: 10, desiredProtectQty: 10,
    });
    expect(plan.allowed).toBe(false);
    // …yet a verified exit SELL (cancel-confirmed) is permitted by the exit gate,
    // which never reads the placement flag.
    const exit = canSubmitCompetingSell({
      reconciledHeldQty: 10, restingProtectiveQty: 10, restingCancellationConfirmed: true, requestedSellQty: 10,
    });
    expect(exit.ok).toBe(true);
  });

  it("even hypothetically enabled, a replace without confirmed cancel is blocked (no double protection)", () => {
    const plan = planProtectivePlacement({
      flag: { protective_orders_enabled: true }, // hypothetical
      symbol: "RELIANCE", market: "india", brokerAccountId: "kite-acct",
      eligibility: eligible, floor, action: "replace_after_cancel",
      reconciledHeldQty: 10, desiredProtectQty: 10,
      restingProtectiveQty: 10, restingCancellationConfirmed: false,
    });
    expect(plan.allowed).toBe(false);
    expect(plan.blockedBy.some((b) => /replace blocked/.test(b))).toBe(true);
  });

  it("even hypothetically enabled, protect qty above held is blocked (long-only)", () => {
    const plan = planProtectivePlacement({
      flag: { protective_orders_enabled: true },
      symbol: "RELIANCE", market: "india", brokerAccountId: "kite-acct",
      eligibility: eligible, floor, action: "place_floor",
      reconciledHeldQty: 10, desiredProtectQty: 11,
    });
    expect(plan.allowed).toBe(false);
    expect(plan.blockedBy.some((b) => /exceeds reconciled held/.test(b))).toBe(true);
  });

  it("even hypothetically enabled, NaN/fractional quantities and cross-market eligibility are blocked", () => {
    for (const desiredProtectQty of [Number.NaN, 1.5]) {
      const plan = planProtectivePlacement({
        flag: { protective_orders_enabled: true }, symbol: "RELIANCE", market: "india", brokerAccountId: "kite-acct",
        eligibility: eligible, floor, action: "place_floor", reconciledHeldQty: 10, desiredProtectQty,
      });
      expect(plan.allowed).toBe(false);
    }
    const cross = planProtectivePlacement({
      flag: { protective_orders_enabled: true }, symbol: "RELIANCE", market: "us", brokerAccountId: "kite-acct",
      eligibility: eligible, floor, action: "place_floor", reconciledHeldQty: 10, desiredProtectQty: 10,
    });
    expect(cross.allowed).toBe(false);
  });
});
