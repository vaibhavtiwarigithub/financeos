-- Scoring P2: add setup_type to shadow_decisions and relax policy_version_id.
-- Archetype shadow rows don't belong to a strategy_version — they're keyed by
-- archetype id (e.g. "quality_momentum"). Dropping NOT NULL lets both row kinds
-- coexist in the same table: policy_version_id=NULL → archetype row; non-null → challenger row.

alter table public.shadow_decisions alter column policy_version_id drop not null;

alter table public.shadow_decisions add column if not exists setup_type text;

create index if not exists shadow_setup_type_idx
  on public.shadow_decisions(setup_type, ts desc);
