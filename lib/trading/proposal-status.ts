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
