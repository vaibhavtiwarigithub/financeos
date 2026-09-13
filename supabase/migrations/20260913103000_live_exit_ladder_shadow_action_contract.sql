-- Keep the production shadow ledger's action vocabulary aligned with the
-- live monitor. This is append-only observation metadata only; it does not
-- enable execution or alter a position/order path.
--
-- Production's original parity migration (20260910022710) is absent from this
-- checkout. That history/reproducibility repair is tracked separately. This
-- migration is deliberately narrow: it repairs the deployed CHECK contract
-- that otherwise rejects the monitor's score_exit observation.

alter table public.live_exit_ladder_shadow
  drop constraint if exists live_exit_ladder_shadow_action_check;

alter table public.live_exit_ladder_shadow
  add constraint live_exit_ladder_shadow_action_check
  check (action = any (array[
    'none',
    'stop_full',
    'partial_target',
    'target_full',
    -- Retained for historical rows written before Decision 74 removed clocks.
    'time_stop',
    'runner_hold',
    -- Produced by the current holding-score confirmation path.
    'score_exit'
  ]));
