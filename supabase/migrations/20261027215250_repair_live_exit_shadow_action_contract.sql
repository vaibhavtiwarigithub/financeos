-- Keep production's append-only live-exit shadow action constraint aligned
-- with the current monitor contract. This only expands accepted observation
-- metadata; it does not enable execution or modify positions/orders.
alter table public.live_exit_ladder_shadow
  drop constraint if exists live_exit_ladder_shadow_action_check;

alter table public.live_exit_ladder_shadow
  add constraint live_exit_ladder_shadow_action_check
  check (action = any (array[
    'none',
    'stop_full',
    'partial_target',
    'target_full',
    'time_stop',
    'runner_hold',
    'score_exit'
  ]));
