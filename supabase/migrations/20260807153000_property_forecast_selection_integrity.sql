-- Bind each new forecast to the coherent source series it was built from.
-- Historical v1 rows remain nullable because append-only evidence is not
-- rewritten to manufacture provenance it did not originally record.
alter table public.property_forecasts
  add column if not exists source_key text
  references public.property_sources(source_key) on delete restrict;

alter table public.property_forecasts
  drop constraint if exists property_forecasts_v2_source_required;
alter table public.property_forecasts
  add constraint property_forecasts_v2_source_required
  check (model_version not like 'drift_uncertainty_v2:%' or source_key is not null);

-- Forecast identity must be idempotent under overlapping cron/manual runs.
-- These records remain append-only; uniqueness prevents irreversible duplicate
-- evidence rather than mutating an existing forecast.
create unique index if not exists property_forecasts_identity_key
  on public.property_forecasts
  (geography_slug, metric_key, horizon_days, cutoff_at, model_version);

-- Freeze the exact append-only observation used as the realized outcome. Older
-- outcome rows remain valid but cannot retroactively invent this provenance.
alter table public.property_forecast_outcomes
  add column if not exists actual_observation_id bigint
  references public.property_market_observations(id) on delete restrict;

create index if not exists property_forecast_outcomes_observation_idx
  on public.property_forecast_outcomes(actual_observation_id)
  where actual_observation_id is not null;
