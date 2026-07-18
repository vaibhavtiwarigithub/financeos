// Hybrid protective stops — RECONCILIATION LOOP (shadow scaffold).
//
// PURE and deterministic — NO broker calls. It takes the last known protective
// record + a fresh broker snapshot (fetched by the caller) and returns the new
// status + the actions to take. It NEVER assumes state: unknown/unread state is
// `needs_reconcile`, never "active" and never "canceled".
//
// Detects out-of-band triggers, partial fills, cancellations, expiry, broker-side
// edits, and corporate actions (a held-qty mismatch). Honesty rules from the spec:
//   - A trigger WITHOUT a confirmed fill does NOT close the book.
//   - A gap through a limit child is reported UNPROTECTED, not called filled.
//   - Expired protection is a CRITICAL health state.
//   - Residual protection after a partial fill can never exceed the held qty.

import { ProtectiveOrderKind } from "@/lib/protective/capabilities";
import {
  LEARNING_SCOPE_RISK_POLICY_ONLY,
  LearningScope,
  PROTECTIVE_EXIT_REASON,
  ProtectiveOrderStatus,
} from "@/lib/protective/state";

export interface BrokerProtectiveSnapshot {
  /** Was the order/trigger found at the broker at all? */
  found: boolean;
  status?: "active" | "triggered" | "filled" | "partially_filled" | "canceled" | "rejected" | "expired" | "unknown";
  filledQty?: number;
  avgFillPrice?: number;
  brokerVersion?: string | null;
  brokerUpdatedAt?: string | null;
  expiry?: string | null;
  /** Reconciled CURRENT holding of the underlying at the broker (for qty/corp-action checks). */
  heldQty?: number;
  /** Set when the broker read itself FAILED — forces needs_reconcile, never an assumption. */
  snapshotError?: string;
  /** Observation time, for expiry comparison. */
  observedAt?: string;
}

export interface ReconcileIssue {
  key: string;
  severity: "warn" | "critical";
  title: string;
  detail: string;
}

export interface ReconcileResult {
  status: ProtectiveOrderStatus;
  /** Did a CONFIRMED fill close (all or part of) the position? */
  positionClosed: boolean;
  closeQty: number;
  /** protective_disaster_floor when a fill closes the book; else null. */
  closeExitReason: string | null;
  /** risk_policy_only for a disaster-floor fill; null when nothing closed. */
  learningScope: LearningScope | null;
  /** Protection still resting and valid after this reconcile (never exceeds held). */
  residualProtectedQty: number;
  /** The residual is unprotected and needs a fresh protective order. */
  needsReplacement: boolean;
  /** True when the broker snapshot could not establish state — do NOT act blind. */
  unresolved: boolean;
  issues: ReconcileIssue[];
  reason: string;
}

export interface ReconcileInput {
  symbol: string;
  brokerAccountId: string;
  orderKind: ProtectiveOrderKind;
  /** Quantity the protective order was covering before this reconcile. */
  priorProtectedQty: number;
  priorStatus: ProtectiveOrderStatus;
  snapshot: BrokerProtectiveSnapshot;
  /** Now, for expiry evaluation (ISO). */
  now: string;
}

function issue(key: string, severity: "warn" | "critical", title: string, detail: string): ReconcileIssue {
  return { key, severity, title, detail };
}

// Clamp any residual protection to the reconciled held quantity — protection can
// never cover more than is actually held (long-only invariant during reconcile).
function clampResidual(residual: number, heldQty: number | undefined): number {
  const r = Math.max(0, residual);
  if (heldQty == null || !Number.isFinite(heldQty)) return r;
  return Math.min(r, Math.max(0, heldQty));
}

export function reconcileProtectiveOrder(input: ReconcileInput): ReconcileResult {
  const { snapshot: s, symbol, orderKind, priorProtectedQty } = input;
  const base: Omit<ReconcileResult, "status" | "reason"> = {
    positionClosed: false,
    closeQty: 0,
    closeExitReason: null,
    learningScope: null,
    residualProtectedQty: 0,
    needsReplacement: false,
    unresolved: false,
    issues: [],
  };

  if (!Number.isFinite(priorProtectedQty) || priorProtectedQty < 0) {
    return {
      ...base,
      status: "needs_reconcile",
      unresolved: true,
      issues: [issue(`protective-invalid-prior:${symbol}`, "critical", `Invalid prior protection for ${symbol}`, "Prior protected quantity is invalid; no broker state may be inferred.")],
      reason: "invalid prior protected quantity",
    };
  }
  if (s.heldQty != null && (!Number.isFinite(s.heldQty) || s.heldQty < 0)) {
    return {
      ...base,
      status: "needs_reconcile",
      unresolved: true,
      residualProtectedQty: priorProtectedQty,
      issues: [issue(`protective-invalid-held:${symbol}`, "critical", `Invalid broker holding for ${symbol}`, "Broker held quantity is invalid; refusing to infer a fill, cancellation, or safe residual.")],
      reason: "invalid broker held quantity",
    };
  }

  // 1) Read failure → never assume. needs_reconcile.
  if (s.snapshotError) {
    return {
      ...base,
      status: "needs_reconcile",
      unresolved: true,
      residualProtectedQty: priorProtectedQty,
      issues: [
        issue(
          `protective-reconcile-read:${symbol}`,
          "critical",
          `Protective order state unreadable for ${symbol}`,
          `Broker snapshot failed (${s.snapshotError}). State is UNKNOWN — not assumed active or canceled.`,
        ),
      ],
      reason: "broker snapshot failed — needs_reconcile",
    };
  }

  // 2) Not found → out-of-band cancel/edit or a stale id. Unknown → needs_reconcile.
  if (!s.found) {
    return {
      ...base,
      status: "needs_reconcile",
      unresolved: true,
      residualProtectedQty: 0,
      needsReplacement: (s.heldQty ?? 0) > 0,
      issues: [
        issue(
          `protective-reconcile-missing:${symbol}`,
          "critical",
          `Protective order not found at broker for ${symbol}`,
          "The resting protective order/trigger is missing (out-of-band cancel, broker edit, or stale id). The position may be unprotected — needs a fresh broker snapshot and replacement.",
        ),
      ],
      reason: "protective order not found at broker — needs_reconcile",
    };
  }

  const filled = Number(s.filledQty ?? 0);
  const expired =
    s.expiry != null && s.expiry !== "" && !Number.isNaN(Date.parse(s.expiry)) && Date.parse(s.expiry) <= Date.parse(input.now);

  switch (s.status) {
    case "filled": {
      if (!Number.isFinite(filled) || filled <= 0 || filled > priorProtectedQty) {
        return {
          ...base,
          status: "needs_reconcile",
          unresolved: true,
          residualProtectedQty: priorProtectedQty,
          issues: [issue(`protective-unconfirmed-fill:${symbol}`, "critical", `Fill quantity unconfirmed for ${symbol}`, "Broker reported filled without a valid positive filled quantity. The position remains open until quantity is confirmed.")],
          reason: "filled status without confirmed quantity",
        };
      }
      return {
        ...base,
        status: "filled",
        positionClosed: true,
        closeQty: filled,
        closeExitReason: PROTECTIVE_EXIT_REASON,
        learningScope: LEARNING_SCOPE_RISK_POLICY_ONLY,
        residualProtectedQty: 0,
        reason: "confirmed disaster-floor fill — position closed with protective_disaster_floor provenance",
      };
    }

    case "partially_filled": {
      if (!Number.isFinite(filled) || filled <= 0 || filled >= priorProtectedQty) {
        return {
          ...base,
          status: "needs_reconcile",
          unresolved: true,
          residualProtectedQty: priorProtectedQty,
          issues: [issue(`protective-invalid-partial:${symbol}`, "critical", `Partial fill quantity invalid for ${symbol}`, "A partial fill must be positive and smaller than the prior protected quantity.")],
          reason: "invalid partial fill quantity",
        };
      }
      // Part of the position closed; the residual needs continued protection and
      // can never exceed the reconciled held qty.
      const residual = clampResidual(priorProtectedQty - filled, s.heldQty);
      return {
        ...base,
        status: "needs_reconcile",
        positionClosed: filled > 0,
        closeQty: filled,
        closeExitReason: filled > 0 ? PROTECTIVE_EXIT_REASON : null,
        learningScope: filled > 0 ? LEARNING_SCOPE_RISK_POLICY_ONLY : null,
        residualProtectedQty: residual,
        needsReplacement: residual > 0,
        issues: [
          issue(
            `protective-partial-fill:${symbol}`,
            "warn",
            `Partial disaster-floor fill for ${symbol}`,
            `${filled} filled; residual ${residual} needs replacement protection. Never blindly resubmit the full remainder.`,
          ),
        ],
        reason: "partial disaster-floor fill — residual needs replacement",
      };
    }

    case "triggered": {
      // A trigger is not a fill. For a LIMIT child (gtt_limit/stop_limit) a gap can
      // leave it UNFILLED — report unprotected, do NOT call it filled/closed.
      const isLimitChild = orderKind === "gtt_limit" || orderKind === "stop_limit";
      return {
        ...base,
        status: "triggered",
        positionClosed: false,
        residualProtectedQty: clampResidual(priorProtectedQty, s.heldQty),
        needsReplacement: false,
        issues: [
          issue(
            `protective-triggered-unfilled:${symbol}`,
            "critical",
            `Protective trigger fired without a confirmed fill for ${symbol}`,
            isLimitChild
              ? "A LIMIT child triggered but has NOT filled — a gap through the limit can leave the position unprotected. Reported unprotected, not filled."
              : "A stop-market triggered; awaiting fill confirmation. The book stays open until a fill is confirmed.",
          ),
        ],
        reason: "triggered without confirmed fill — book stays open",
      };
    }

    case "canceled":
    case "rejected": {
      const heldQty = s.heldQty ?? 0;
      return {
        ...base,
        status: "canceled",
        residualProtectedQty: 0,
        needsReplacement: heldQty > 0,
        issues:
          heldQty > 0
            ? [
                issue(
                  `protective-canceled-held:${symbol}`,
                  "critical",
                  `Protective order ${s.status} while ${symbol} is still held`,
                  `Broker-side ${s.status}; ${heldQty} still held and now UNPROTECTED. Replacement required (cancel/replace qty invariant applies).`,
                ),
              ]
            : [],
        reason: `broker-side ${s.status} detected`,
      };
    }

    case "expired": {
      return {
        ...base,
        status: "canceled",
        residualProtectedQty: 0,
        needsReplacement: (s.heldQty ?? 0) > 0,
        issues: [
          issue(
            `protective-expired:${symbol}`,
            "critical",
            `Protective order EXPIRED for ${symbol}`,
            "Expired protection is a critical health state. The position is unprotected until a fresh order is placed and reconciled.",
          ),
        ],
        reason: "protective order expired",
      };
    }

    case "active": {
      // Detect approaching/passed expiry and corporate-action qty drift.
      const issues: ReconcileIssue[] = [];
      if (expired) {
        issues.push(
          issue(
            `protective-expired:${symbol}`,
            "critical",
            `Protective order past expiry for ${symbol}`,
            "The broker reports active but the expiry has passed — treat as unprotected pending a fresh snapshot.",
          ),
        );
      }
      // Corporate action / drift: protected qty exceeds current held qty.
      const heldQty = s.heldQty;
      let residual = priorProtectedQty;
      let corpAction = false;
      if (heldQty != null && Number.isFinite(heldQty) && priorProtectedQty > heldQty) {
        corpAction = true;
        residual = clampResidual(priorProtectedQty, heldQty);
        issues.push(
          issue(
            `protective-qty-drift:${symbol}`,
            "critical",
            `Protective qty exceeds held qty for ${symbol}`,
            `Protecting ${priorProtectedQty} but only ${heldQty} held (split, symbol change, delisting, or partial sale). A fresh broker snapshot is required before any replacement; the cancel/replace qty invariant must hold.`,
          ),
        );
      }
      if (expired || corpAction) {
        return {
          ...base,
          status: "needs_reconcile",
          unresolved: true,
          residualProtectedQty: residual,
          needsReplacement: true,
          issues,
          reason: expired ? "active-but-expired — needs_reconcile" : "held-qty drift (corporate action) — needs_reconcile",
        };
      }
      return {
        ...base,
        status: "active",
        residualProtectedQty: clampResidual(priorProtectedQty, heldQty),
        reason: "protective order active and reconciled",
      };
    }

    default: {
      // "unknown" or any unmapped status → never assume. needs_reconcile.
      return {
        ...base,
        status: "needs_reconcile",
        unresolved: true,
        residualProtectedQty: priorProtectedQty,
        issues: [
          issue(
            `protective-unknown-status:${symbol}`,
            "critical",
            `Unknown protective order status for ${symbol}`,
            `Broker reported status '${s.status ?? "none"}'. State is unknown — not assumed active or canceled.`,
          ),
        ],
        reason: "unknown broker status — needs_reconcile",
      };
    }
  }
}
