-- Append-only operator review of immutable experiment artifacts. This does not
-- mutate results; it records whether an artifact remains admissible after
-- post-run data-quality review.

create table if not exists public.backtest_experiment_quality_reviews (
  id uuid primary key default gen_random_uuid(),
  experiment_id uuid not null unique
    references public.backtest_experiments(id) on delete restrict,
  verdict text not null
    check (verdict in ('accepted_diagnostic', 'invalidated')),
  reason_code text not null check (length(reason_code) between 3 and 80),
  detail text not null check (length(detail) between 3 and 1000),
  superseded_by_experiment_id uuid
    references public.backtest_experiments(id) on delete restrict,
  reviewer text not null default 'operator'
    check (reviewer in ('operator', 'system')),
  created_at timestamptz not null default now(),
  check (superseded_by_experiment_id is distinct from experiment_id),
  check (
    verdict = 'invalidated'
    or superseded_by_experiment_id is null
  )
);

create index if not exists backtest_experiment_quality_reviews_created_idx
  on public.backtest_experiment_quality_reviews(created_at desc);

create or replace function public.reject_backtest_experiment_quality_review_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'backtest experiment quality reviews are append-only';
end;
$$;

drop trigger if exists backtest_experiment_quality_reviews_no_update
  on public.backtest_experiment_quality_reviews;
create trigger backtest_experiment_quality_reviews_no_update
  before update or delete on public.backtest_experiment_quality_reviews
  for each row execute function public.reject_backtest_experiment_quality_review_mutation();

alter table public.backtest_experiment_quality_reviews enable row level security;
revoke all on table public.backtest_experiment_quality_reviews from anon, authenticated;
grant select, insert on table public.backtest_experiment_quality_reviews to service_role;
revoke update, delete, truncate on table public.backtest_experiment_quality_reviews from service_role;
