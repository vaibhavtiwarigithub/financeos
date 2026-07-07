-- PositionMonitor trailed every stop at a hardcoded 7% (newHighest * 0.93) and
-- overwrote stop_loss with it each run — discarding the MAE-derived stop
-- DISTANCE that PaperTrader sets at fill (Phase 2 dynamic R:R). Store the
-- initial stop once, immutably, so the monitor can trail at the position's own
-- volatility-appropriate distance instead of a fixed 7%.
alter table paper_positions add column if not exists initial_stop_loss numeric;

-- Copy stop_loss -> initial_stop_loss on insert (once). A trigger keeps this
-- out of the execute_paper_fill RPC and the legacy insert path — neither needs
-- to change.
create or replace function set_initial_stop_loss()
returns trigger
language plpgsql
as $$
begin
  if new.initial_stop_loss is null then
    new.initial_stop_loss := new.stop_loss;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_set_initial_stop_loss on paper_positions;
create trigger trg_set_initial_stop_loss
  before insert on paper_positions
  for each row execute function set_initial_stop_loss();

-- Backfill open rows: best-effort seed from the current stop_loss. Positions
-- that have already trailed will get an approximate anchor, correct going
-- forward; new fills are exact.
update paper_positions set initial_stop_loss = stop_loss
  where initial_stop_loss is null and stop_loss is not null;
