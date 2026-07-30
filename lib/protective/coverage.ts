// Protection coverage is a control-plane read model. It never talks to a broker,
// changes a protective order, or treats a database intent as broker protection.
// A live autonomous BUY is allowed only after a future placement worker has both
// created and reconciled a full-quantity active protective order.

import { canonicalPositionSymbol } from "@/lib/trading/live-position-ledger";

export type ProtectionMarket = "us" | "india";

export interface ManagedLivePosition {
  market: ProtectionMarket;
  broker: string;
  brokerAccountId: string;
  symbol: string;
  qty: number;
}

export interface ProtectiveOrderCoverageRow {
  position_id: string;
  broker: string;
  broker_account_id: string;
  market: string;
  symbol: string;
  protected_qty: number | string | null;
  reconciled_held_qty: number | string | null;
  status: string;
  broker_order_id: string | null;
  kite_trigger_id: string | null;
  expiry: string | null;
}

export interface PositionProtectionFinding {
  positionId: string;
  market: ProtectionMarket;
  symbol: string;
  protected: boolean;
  reason: string;
}

export interface ProtectionCoverageResult {
  protected: boolean;
  findings: PositionProtectionFinding[];
}

/**
 * Stable key shared by the future placement/reconciliation worker and every
 * coverage reader. It identifies an account-local net position, never a lot.
 */
export function managedLivePositionId(position: ManagedLivePosition): string {
  return [
    position.market,
    position.broker.trim().toLowerCase(),
    position.brokerAccountId.trim(),
    canonicalPositionSymbol(position.symbol, position.market),
  ].join(":");
}

function finitePositive(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : null;
}

function activeAndUnexpired(row: ProtectiveOrderCoverageRow, now: Date): string | null {
  if (row.status !== "active") return `protective order status is ${row.status || "missing"}, not active`;
  const brokerIds = [row.broker_order_id, row.kite_trigger_id].filter((id) => typeof id === "string" && id.trim().length > 0);
  if (brokerIds.length !== 1) return "active protection lacks exactly one broker identifier";
  if (row.expiry) {
    const expiry = Date.parse(row.expiry);
    if (!Number.isFinite(expiry) || expiry <= now.getTime()) return "protective order is expired or has an invalid expiry";
  }
  return null;
}

/**
 * A partial floor is not coverage. The currently reconstructed held quantity,
 * the reconciled held quantity, and the broker-protected quantity must all cover
 * the entire position. Multiple rows never combine: the schema permits only one
 * active protective order for a position/broker, and combining them would hide a
 * cancel/replace overlap.
 */
export function evaluateProtectionCoverage(input: {
  positions: ManagedLivePosition[];
  protectiveOrders: ProtectiveOrderCoverageRow[];
  now?: Date;
}): ProtectionCoverageResult {
  const now = input.now ?? new Date();
  const byPositionId = new Map<string, ProtectiveOrderCoverageRow[]>();
  for (const row of input.protectiveOrders) {
    const rows = byPositionId.get(row.position_id) ?? [];
    rows.push(row);
    byPositionId.set(row.position_id, rows);
  }

  const findings = input.positions.map((position): PositionProtectionFinding => {
    const positionId = managedLivePositionId(position);
    const qty = finitePositive(position.qty);
    if (qty == null) {
      return { positionId, market: position.market, symbol: position.symbol, protected: false, reason: "managed position has invalid quantity" };
    }
    const matches = (byPositionId.get(positionId) ?? []).filter((row) =>
      row.market === position.market &&
      row.broker === position.broker &&
      row.broker_account_id === position.brokerAccountId &&
      canonicalPositionSymbol(row.symbol, position.market) === canonicalPositionSymbol(position.symbol, position.market),
    );
    if (matches.length !== 1) {
      return {
        positionId,
        market: position.market,
        symbol: position.symbol,
        protected: false,
        reason: matches.length === 0 ? "no matching protective order" : "multiple matching protective orders require reconciliation",
      };
    }
    const row = matches[0];
    const stateFailure = activeAndUnexpired(row, now);
    if (stateFailure) return { positionId, market: position.market, symbol: position.symbol, protected: false, reason: stateFailure };
    const protectedQty = finitePositive(row.protected_qty);
    const reconciledHeldQty = finitePositive(row.reconciled_held_qty);
    if (protectedQty == null || reconciledHeldQty == null || protectedQty + 1e-9 < qty || reconciledHeldQty + 1e-9 < qty) {
      return { positionId, market: position.market, symbol: position.symbol, protected: false, reason: "protective quantity does not fully cover the reconstructed holding" };
    }
    return { positionId, market: position.market, symbol: position.symbol, protected: true, reason: "active full-quantity broker protection reconciled" };
  });

  return { protected: findings.every((finding) => finding.protected), findings };
}

/**
 * Deliberately false until a broker-specific placement/reconciliation worker is
 * implemented and approved. A DB flag alone can never make autonomous live BUYs
 * eligible. This avoids a configuration-only path into unprotected positions.
 */
export const PROTECTIVE_PLACEMENT_WORKER_AVAILABLE = false;

export function evaluateAutonomousEntryProtection(input: {
  placementEnabled: boolean;
  placementWorkerAvailable?: boolean;
  coverage: ProtectionCoverageResult;
}): { ok: true } | { ok: false; reason: string } {
  if (!input.placementEnabled) return { ok: false, reason: "protective_orders_enabled=false" };
  if (!(input.placementWorkerAvailable ?? PROTECTIVE_PLACEMENT_WORKER_AVAILABLE)) {
    return { ok: false, reason: "protective placement worker is not implemented" };
  }
  const uncovered = input.coverage.findings.filter((finding) => !finding.protected);
  if (uncovered.length) {
    return { ok: false, reason: `unprotected managed live position(s): ${uncovered.map((finding) => `${finding.market}/${finding.symbol}`).join(", ")}` };
  }
  return { ok: true };
}
