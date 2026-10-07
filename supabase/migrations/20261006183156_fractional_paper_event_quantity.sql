-- Preserve fractional US paper quantities in the immutable fill-event ledger.
-- Existing integer values convert exactly; historical event rows are not
-- reconciled or otherwise changed here.
begin;

alter table public.paper_order_events
  alter column qty type numeric using qty::numeric;

commit;
