-- Hard backstop against the concurrent-double-click race in the Execution
-- Gateway: at most one active order per proposal. The check-then-insert in the
-- route can be beaten by two simultaneous "Send to broker" clicks; this index
-- makes the second insert fail instead of double-submitting a real order.
create unique index if not exists broker_orders_one_active_per_proposal
  on broker_orders (proposal_id)
  where status in ('pending_submit', 'submitted', 'partially_filled');
