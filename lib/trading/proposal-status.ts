export const TRADE_PROPOSAL_STATUS = {
  PENDING_REVIEW: "pending_review",
  APPROVED: "approved",
  REJECTED: "rejected",
  EXPIRED: "expired",
  SUBMITTED: "submitted",
  FILLED: "filled",
  FAILED: "failed",
  CANCELLED: "cancelled",
  QUEUED_AUTO: "queued_auto",
  MANUAL_REVIEW_REQUIRED: "manual_review_required",
} as const;

export type TradeProposalStatus =
  typeof TRADE_PROPOSAL_STATUS[keyof typeof TRADE_PROPOSAL_STATUS];

export const TRADE_PROPOSAL_VISIBLE_STATUSES: TradeProposalStatus[] =
  Object.values(TRADE_PROPOSAL_STATUS);

// ── Shadow proposals are evidence, never work items ──────────────────────────
//
// `runAutonomousShadow` writes a real `trade_proposals` row per signal so the
// kernel/sizing decision has somewhere to live. Those rows must never reach a
// surface that treats a proposal as actionable — the approve queue, the
// desktop notification, or the 24h "already proposed" dedup that suppresses
// real proposals for the same signal.
//
// Excluded by execution_mode rather than by status, because a shadow row
// legitimately carries the same terminal statuses a real proposal does.
export const SHADOW_EXECUTION_MODE = "autonomous_shadow";

// NULL-safe. `execution_mode` is nullable (default 'manual'), and SQL
// three-valued logic makes `execution_mode <> 'autonomous_shadow'` evaluate to
// NULL — i.e. filtered OUT — for a row whose mode is NULL. A bare .neq() would
// therefore silently hide legitimate legacy proposals. Keep the IS NULL arm.
export const EXCLUDE_SHADOW_FILTER =
  `execution_mode.is.null,execution_mode.neq.${SHADOW_EXECUTION_MODE}`;

export function isShadowProposal(row: { execution_mode?: string | null } | null | undefined): boolean {
  return row?.execution_mode === SHADOW_EXECUTION_MODE;
}
