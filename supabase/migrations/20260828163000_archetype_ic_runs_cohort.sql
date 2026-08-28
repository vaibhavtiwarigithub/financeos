-- Records WHICH population an archetype grade was measured on.
--
-- Before 2026-08-28 the grader scored every archetype against all scored
-- observations, including neutral/short rows the book could never enter. The
-- table had no way to express that, so a corrected eligible-long grade and a
-- contaminated all-scored one would have been indistinguishable.
--
-- The table is empty at the time of this migration (0 rows), so the DEFAULT
-- exists only to label any row written by code that predates the fix; it is
-- deliberately the UNSAFE value so an unlabelled write is visible rather than
-- silently trusted.
--
-- APPLIED to production 2026-08-28 and verified via information_schema.
alter table archetype_ic_runs
  add column if not exists cohort text not null default 'all_scored';

alter table archetype_ic_runs
  drop constraint if exists archetype_ic_runs_cohort_check;

alter table archetype_ic_runs
  add constraint archetype_ic_runs_cohort_check
  check (cohort = any (array['eligible_long'::text, 'all_scored'::text]));

comment on column archetype_ic_runs.cohort is
  'Population the rank IC was measured on. eligible_long = entry_eligible AND direction=long (the only cohort a weighting conclusion may cite). all_scored = every scored observation, context only.';
