// Hybrid protective stops — BROKER-NEUTRAL CAPABILITY MATRIX (shadow scaffold).
//
// SHADOW ONLY. Nothing in this module places, modifies, or cancels a broker
// order. It declares what each broker CAN do and answers "is this exact position
// protectable by this broker, and how strongly?" — a pure, deterministic query.
//
// Protection is driven by a broker-neutral state machine that reads DECLARED
// capabilities per adapter — never by per-broker `if` branches in the protocol
// (spec §"Broker-Neutral Capability Matrix"). A flat broker-level boolean is
// FORBIDDEN: support varies by order type, instrument, session, TIF, account
// entitlement, and environment. Webull may document a GTC stop-market in CORE and
// that still does not prove the same stop triggers in an extended/overnight
// session — session eligibility is separate from time-in-force persistence.
//
// Preference order (spec): stop-market where verified (designed to TRIGGER a
// market order — no guaranteed execution or fill price) → GTT / stop-limit as
// WEAKER protection whose unfilled-trigger risk must be surfaced. An adapter with
// no eligible MULTI-DAY order for the exact position is declared synthetic-only:
// the position is flagged unprotected-by-broker, NEVER silently treated as
// protected.

export type Market = "us" | "india";
export type InstrumentType = "equity";
export type ProtectiveSide = "sell_long";
// Broker-declared account entitlement (Kite CNC delivery, RH cash/margin, …).
export type AccountMode = "cash" | "margin" | "cnc" | "delivery";
export type ProtectiveOrderKind = "stop_market" | "stop_limit" | "gtt_limit";
// GTC = persists ACROSS trading days. It does NOT mean the order can trigger in
// every session — that is `sessions`, checked independently.
export type TimeInForce = "day" | "gtc" | "broker_managed";
export type Session = "regular" | "extended" | "overnight";
export type UpdateMode = "modify_in_place" | "cancel_replace" | "none";

export interface ProtectiveOrderCapability {
  timeInForce: TimeInForce[];
  sessions: Session[];
  updateMode: UpdateMode;
  // null = no broker-imposed lifetime cap; a number is the max validity in days.
  maxLifetimeDays: number | null;
  oco: boolean;
}

export interface BrokerProtectiveCapabilities {
  broker: string;
  scope: {
    market: Market;
    instrumentTypes: InstrumentType[];
    sides: ProtectiveSide[];
    accountModes: AccountMode[];
  };
  // Partial: an adapter declares ONLY combinations it has proved. An absent kind
  // is not "unsupported-but-maybe" — it is simply not declared, so it is never
  // selected.
  orders: Partial<Record<ProtectiveOrderKind, ProtectiveOrderCapability>>;
}

// The exact position that needs protecting. `minLifetimeDays` encodes the
// multi-day requirement (a disaster floor must outlive a single session);
// `session` is the session the floor must be able to TRIGGER in.
export interface ProtectionRequest {
  market: Market;
  instrumentType: InstrumentType;
  accountMode: AccountMode;
  side: ProtectiveSide;
  minLifetimeDays: number;
  session: Session;
}

// A kind's protection strength. `stop_market` is designed to trigger a market
// order (strong-but-not-guaranteed); a limit child (`gtt_limit`/`stop_limit`)
// controls price but MAY NEVER FILL on a gap — genuinely weaker.
export type ProtectionStrength = "stop_market" | "weaker_limit";

export type ProtectionEligibility =
  | {
      protectedByBroker: true;
      kind: ProtectiveOrderKind;
      strength: ProtectionStrength;
      capability: ProtectiveOrderCapability;
      /** Honest limitation notes for the UI/record — never omitted. */
      caveats: string[];
      /** Kinds that were declared but rejected, with the reason each failed. */
      rejected: { kind: ProtectiveOrderKind; reason: string }[];
    }
  | {
      protectedByBroker: false;
      unprotectedByBroker: true;
      /** Why NO declared kind qualified — this is a first-class reported state. */
      reason: string;
      rejected: { kind: ProtectiveOrderKind; reason: string }[];
    };

// Preference: strong (stop_market) first, then weaker limit kinds.
const PREFERENCE_ORDER: ProtectiveOrderKind[] = ["stop_market", "gtt_limit", "stop_limit"];

function persistsMultiDay(tif: TimeInForce[]): boolean {
  // A DAY-only order can never be a multi-day protective floor; do NOT renew DAY
  // stops as hidden cron state (spec). Only gtc / broker_managed persist.
  return tif.includes("gtc") || tif.includes("broker_managed");
}

function strengthOf(kind: ProtectiveOrderKind): ProtectionStrength {
  return kind === "stop_market" ? "stop_market" : "weaker_limit";
}

function caveatsFor(kind: ProtectiveOrderKind, cap: ProtectiveOrderCapability): string[] {
  const out: string[] = [];
  if (kind === "stop_market") {
    out.push(
      "Stop-market: designed to TRIGGER a market order; execution and fill price are NOT guaranteed during gaps, halts, or venue/broker outages.",
    );
  } else {
    out.push(
      "Limit-child protection (GTT/stop-limit): controls price but MAY NEVER FILL on a gap — the position can stay unprotected and that must be reported, not called filled.",
    );
  }
  if (!cap.sessions.includes("extended") && !cap.sessions.includes("overnight")) {
    out.push("Cannot trigger while the session is closed — does not cover the gap between close and next open.");
  }
  return out;
}

// Evaluate whether a broker can protect THIS position, and how strongly.
// Pure and deterministic — no broker calls, no side effects.
export function evaluateProtection(
  caps: BrokerProtectiveCapabilities,
  req: ProtectionRequest,
): ProtectionEligibility {
  const rejected: { kind: ProtectiveOrderKind; reason: string }[] = [];

  // Scope gates apply to the WHOLE adapter (market/instrument/side/account).
  const scopeFail =
    caps.scope.market !== req.market
      ? `broker market ${caps.scope.market} != position market ${req.market}`
      : !caps.scope.instrumentTypes.includes(req.instrumentType)
        ? `instrument ${req.instrumentType} not in broker scope`
        : !caps.scope.sides.includes(req.side)
          ? `side ${req.side} not in broker scope`
          : !caps.scope.accountModes.includes(req.accountMode)
            ? `account mode ${req.accountMode} not in broker scope`
            : null;
  if (scopeFail) {
    return { protectedByBroker: false, unprotectedByBroker: true, reason: `out of broker scope: ${scopeFail}`, rejected };
  }

  for (const kind of PREFERENCE_ORDER) {
    const cap = caps.orders[kind];
    if (!cap) continue; // not declared → never selected
    if (!cap.sessions.includes(req.session)) {
      rejected.push({ kind, reason: `cannot trigger in ${req.session} session (declared: ${cap.sessions.join("/") || "none"})` });
      continue;
    }
    if (req.minLifetimeDays >= 1 && !persistsMultiDay(cap.timeInForce)) {
      rejected.push({ kind, reason: `no multi-day TIF (declared: ${cap.timeInForce.join("/") || "none"}); a DAY order is not a multi-day floor` });
      continue;
    }
    if (cap.maxLifetimeDays != null && req.minLifetimeDays > cap.maxLifetimeDays) {
      rejected.push({ kind, reason: `required lifetime ${req.minLifetimeDays}d exceeds broker max ${cap.maxLifetimeDays}d` });
      continue;
    }
    return {
      protectedByBroker: true,
      kind,
      strength: strengthOf(kind),
      capability: cap,
      caveats: caveatsFor(kind, cap),
      rejected,
    };
  }

  return {
    protectedByBroker: false,
    unprotectedByBroker: true,
    reason:
      rejected.length > 0
        ? `no eligible multi-day protective order for this position (synthetic-only): ${rejected.map((r) => `${r.kind} — ${r.reason}`).join("; ")}`
        : "broker declares no protective order kinds (synthetic-only)",
    rejected,
  };
}
