-- Include unknown_needs_reconcile in the active-order uniqueness so a proposal
-- whose place() outcome was ambiguous (possible-success timeout, or success
-- with no parseable order id) cannot be resubmitted until it's reconciled via
-- get_equity_orders. Prevents a duplicate real order.
drop index if exists broker_orders_one_active_per_proposal;
create unique index broker_orders_one_active_per_proposal
  on broker_orders (proposal_id)
  where status in ('pending_submit', 'submitted', 'partially_filled', 'unknown_needs_reconcile');
