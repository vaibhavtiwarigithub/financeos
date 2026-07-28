-- Walk-forward IC folds — build order steps 2+3 (architecture approved 2026-07-28).
-- features/walk-forward-ic-folds/FEATURE_ARCHITECTURE.md
--
-- Repairs strategy_policies semantics and replaces the non-atomic
-- supersede-then-insert in the promote route with one locked RPC transaction.
--
-- SAFE TO RUN DESTRUCTIVELY: verified immediately before applying —
--   strategy_policies = 0 rows, backtest_experiments = 0 rows, 0 superseded.
-- This is the last moment these columns can be renamed without a data migration.

-- ─── 1. Naming repair ────────────────────────────────────────────────────────
-- `dsr` never held a Deflated Sharpe Ratio. The gate computes
-- t_latest − E[max t over trials]: the trial-count adjustment term only. Real
-- DSR additionally needs sample length and return skew/kurtosis and is computed
-- on cost-adjusted STRATEGY RETURNS, not on an information coefficient.
-- No `dsr` column is re-added; add one when an actual DSR exists to put in it.
alter table public.strategy_policies rename column dsr to t_margin_vs_trials;

-- `walk_forward_pass` never held a walk-forward result. The legacy IC windows
-- overlap ~98.4% and replay a current-liquid universe through past dates.
alter table public.strategy_policies rename column walk_forward_pass to ic_stability_pass;

-- ─── 2. Evidence class is explicit and legacy windows can never promote ──────
-- Constrained to out-of-sample modes only. A rolling-window result has no
-- representable value here, which structurally enforces the architecture's
-- "no policy can be created from legacy edge_ic_history alone".
alter table public.strategy_policies
  add column validation_mode text not null
    check (validation_mode in ('purged_temporal_oos', 'walk_forward'));

-- ─── 3. Every policy is bound to the exact experiment that justifies it ──────
alter table public.strategy_policies
  add column experiment_id uuid not null references public.backtest_experiments(id);

create index if not exists strategy_policies_experiment_idx
  on public.strategy_policies (experiment_id);

-- ─── 4. Immutability, stated correctly and enforced completely ───────────────
-- The previous trigger listed 10 columns by hand while its comment claimed
-- "only superseded_at may be updated" — dsr, pbo, walk_forward_pass,
-- cost_adjusted_return, max_drawdown_pct, stability_score and notes were all
-- silently mutable. Comparing whole rows minus superseded_at closes that gap
-- and stays correct when columns are added later.
create or replace function public.strategy_policies_guard_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (to_jsonb(old) - 'superseded_at') is distinct from (to_jsonb(new) - 'superseded_at') then
    raise exception 'strategy_policies: only superseded_at may be updated after insert';
  end if;
  -- One-way transition: an active policy may be retired, never resurrected,
  -- and a retirement timestamp may never be rewritten.
  if old.superseded_at is not null and new.superseded_at is distinct from old.superseded_at then
    raise exception 'strategy_policies: superseded_at is write-once (% -> %)', old.superseded_at, new.superseded_at;
  end if;
  return new;
end;
$$;

-- ─── 5. Experiment → policy binding is also one-way ──────────────────────────
create or replace function public.backtest_experiments_guard_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (old.hypothesis       is distinct from new.hypothesis or
      old.author           is distinct from new.author or
      old.variant_budget   is distinct from new.variant_budget or
      old.experiment_type  is distinct from new.experiment_type or
      old.market           is distinct from new.market or
      old.segment_type     is distinct from new.segment_type or
      old.segment_value    is distinct from new.segment_value) then
    raise exception 'backtest_experiments: hypothesis, author, budget, type, and segment are immutable after insert';
  end if;
  if old.policy_id is not null and new.policy_id is distinct from old.policy_id then
    raise exception 'backtest_experiments: policy_id is write-once (% -> %)', old.policy_id, new.policy_id;
  end if;
  return new;
end;
$$;

-- ─── 6. Atomic promotion ─────────────────────────────────────────────────────
-- P0 this fixes: the route superseded the incumbent and then inserted. If the
-- insert failed, the segment was left with NO active policy. The partial unique
-- index prevents two active rows but cannot prevent zero.
--
-- Note the operation order is supersede-then-insert, inverted from the prose in
-- the architecture doc. That is deliberate: strategy_policies_active_segment_uidx
-- is a non-deferrable partial unique index, so an insert while the incumbent is
-- still active would violate it. Atomicity comes from the transaction, not the
-- ordering — if the insert raises, the supersede rolls back with it.
create or replace function public.promote_strategy_policy(
  p_experiment_id      uuid,
  p_market             text,
  p_sector             text,
  p_regime             text,
  p_horizon_days_min   int,
  p_horizon_days_max   int,
  p_model_id           text,
  p_validation_mode    text,
  p_sample_n           int,
  p_t_margin_vs_trials double precision,
  p_ic_stability_pass  boolean,
  p_notes              text
)
returns jsonb
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $$
declare
  v_exp        public.backtest_experiments%rowtype;
  v_incumbent  uuid;
  v_new_id     uuid;
  v_verdict    text;
begin
  if p_market not in ('us', 'india') then
    raise exception 'market_scope_mismatch: market must be us or india, got %', p_market;
  end if;
  if p_sector is not null and p_regime is not null then
    raise exception 'experiment_scope_mismatch: sector and regime cannot both be set';
  end if;
  if p_horizon_days_min is null or p_horizon_days_max is null
     or p_horizon_days_min <= 0 or p_horizon_days_max < p_horizon_days_min then
    raise exception 'invalid horizon band %..%', p_horizon_days_min, p_horizon_days_max;
  end if;

  -- The experiment must exist and must describe THIS segment. Without this a
  -- favourable trial count from an unrelated experiment could justify any edge.
  select * into v_exp from public.backtest_experiments where id = p_experiment_id for update;
  if not found then
    raise exception 'trial_family_incomplete: experiment % not found', p_experiment_id;
  end if;
  if v_exp.market is distinct from p_market then
    raise exception 'market_scope_mismatch: experiment market % <> requested %', v_exp.market, p_market;
  end if;
  if v_exp.segment_type is distinct from (case when p_sector is not null then 'sector'
                                               when p_regime is not null then 'regime'
                                               else 'market' end)
     or v_exp.segment_value is distinct from coalesce(p_sector, p_regime, 'all') then
    raise exception 'experiment_scope_mismatch: experiment segment %/% <> requested',
      v_exp.segment_type, v_exp.segment_value;
  end if;
  if v_exp.policy_id is not null then
    raise exception 'experiment % already bound to policy %', p_experiment_id, v_exp.policy_id;
  end if;
  if coalesce(v_exp.variants_run, 0) < 1 then
    raise exception 'trial_family_incomplete: experiment has no recorded variants_run';
  end if;

  -- Serialize every promotion for this exact segment.
  perform pg_advisory_xact_lock(hashtext(
    'strategy-policy:' || p_market || ':' || coalesce(p_sector, '__all__') || ':' ||
    coalesce(p_regime, '__all__') || ':' || p_horizon_days_min || ':' || p_horizon_days_max));

  select id into v_incumbent
  from public.strategy_policies
  where market = p_market
    and sector is not distinct from p_sector
    and regime is not distinct from p_regime
    and horizon_days_min = p_horizon_days_min
    and horizon_days_max = p_horizon_days_max
    and superseded_at is null
  for update;

  v_verdict := case when v_incumbent is null then 'baseline' else 'variant' end;

  if v_incumbent is not null then
    update public.strategy_policies set superseded_at = now() where id = v_incumbent;
  end if;

  insert into public.strategy_policies (
    market, sector, regime, horizon_days_min, horizon_days_max, model_id,
    validation_mode, experiment_id, verdict, sample_n,
    t_margin_vs_trials, ic_stability_pass, promoted_by, notes
  ) values (
    p_market, p_sector, p_regime, p_horizon_days_min, p_horizon_days_max, p_model_id,
    p_validation_mode, p_experiment_id, v_verdict, p_sample_n,
    p_t_margin_vs_trials, p_ic_stability_pass, 'deterministic_gate', p_notes
  ) returning id into v_new_id;

  update public.backtest_experiments
     set policy_id = v_new_id, completed_at = coalesce(completed_at, now())
   where id = p_experiment_id;

  return jsonb_build_object(
    'policy_id',   v_new_id,
    'superseded',  v_incumbent,
    'verdict',     v_verdict,
    'market',      p_market
  );
end;
$$;

-- Service role only. This function is SECURITY DEFINER and writes a governance
-- ledger; no browser-reachable role may execute it.
revoke all on function public.promote_strategy_policy(
  uuid, text, text, text, int, int, text, text, int, double precision, boolean, text
) from public, anon, authenticated;
grant execute on function public.promote_strategy_policy(
  uuid, text, text, text, int, int, text, text, int, double precision, boolean, text
) to service_role;
