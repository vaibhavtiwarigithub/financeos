-- Cross-sectional rank (features/cross-sectional-rank) — additive, idempotent.
-- Reuses the migration 137 tables; adds richer rank provenance and the
-- agent_signals audit columns for the hybrid floor-AND-rank entry gate.
-- NOTE: OFF by default — the genome's entry.rank_pct_min defaults to 0.0, so no
-- selection changes until a validated challenger is owner-promoted. This
-- migration only widens the schema; it changes no data and no live behavior.

-- universe_snapshot_scores: grouped-rank provenance (all nullable, additive).
alter table public.universe_snapshot_scores
  add column if not exists rank_quality         text,     -- 'ok' | 'degraded' | 'excluded_held' | 'excluded_abstain' | 'excluded_conf'
  add column if not exists comparable_group_key text,     -- e.g. 'us:equity:technology'
  add column if not exists group_n              int,      -- eligible names in the FINAL assigned group that day
  add column if not exists rank_eligible        boolean;  -- passed §4.1 data-quality gates → counted in a group

comment on column public.universe_snapshot_scores.rank_quality is
  'ok = real empirical percentile; degraded = small-group fixed transform; excluded_* = failed data-quality gate (rank_pct null)';
comment on column public.universe_snapshot_scores.comparable_group_key is
  'market:asset-type:sector (or :all fallback). ETFs never share a group with single-name equities.';

-- agent_signals: record why/whether a candidate was rank-rejected. Canonical PIT
-- truth stays in decision_observations (append-only); this is a mutable audit
-- surface PaperTrader already reads (status).
alter table public.agent_signals
  add column if not exists rank_pct       numeric,
  add column if not exists rank_rejected  boolean default false;

-- rank_pct range guard on agent_signals (mirrors the existing check on
-- universe_snapshot_scores). NOT VALID first, then validate, so it is safe on a
-- table with pre-existing rows. Guarded so re-running the migration is a no-op.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'agent_signals_rank_pct_range'
  ) then
    alter table public.agent_signals
      add constraint agent_signals_rank_pct_range
      check (rank_pct is null or (rank_pct >= 0 and rank_pct <= 1)) not valid;
    alter table public.agent_signals validate constraint agent_signals_rank_pct_range;
  end if;
end $$;

-- New agent_signals.status value 'rank_rejected' for candidates that cleared the
-- absolute floor but failed the cross-sectional rank gate (distinct from
-- expired/neutral so the Research Journal can explain "scored well but wasn't
-- the best available today"). status is free text (no enum), so no type change
-- is required — documented here for provenance.
