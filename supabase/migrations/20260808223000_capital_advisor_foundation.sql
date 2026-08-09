-- Capital Plan: private owner-entered planning records. This is not a money path.
create table if not exists public.capital_profiles (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  encrypted_payload text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.capital_profile_snapshots (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  encrypted_payload text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.capital_area_watchlists (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  geography_slug text not null references public.property_geographies(slug),
  display_label text not null check (char_length(display_label) between 1 and 80),
  locality_kind text not null check (locality_kind in ('metro','city','zip','pin','locality')),
  locality_reference text not null check (char_length(locality_reference) between 1 and 120),
  asset_focus text not null check (asset_focus in ('home','rental','land','mixed')),
  encrypted_payload text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.capital_decision_runs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  run_kind text not null check (run_kind in ('mortgage_prepayment','cross_asset_comparison','area_watch_snapshot')),
  decision_state text not null check (decision_state in ('review_principal_payment','review_property','review_market','watch','outside_policy','indifferent_under_assumptions','insufficient_evidence')),
  engine_version text not null,
  encrypted_inputs text not null,
  encrypted_result text not null,
  evidence_refs jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists capital_area_watchlists_owner_idx on public.capital_area_watchlists(owner_id, active, updated_at desc);
create index if not exists capital_decision_runs_owner_idx on public.capital_decision_runs(owner_id, created_at desc);

alter table public.capital_profiles enable row level security;
alter table public.capital_profile_snapshots enable row level security;
alter table public.capital_area_watchlists enable row level security;
alter table public.capital_decision_runs enable row level security;
revoke all on public.capital_profiles, public.capital_profile_snapshots, public.capital_area_watchlists, public.capital_decision_runs from anon, authenticated;

create or replace function public.prevent_capital_advisor_mutation()
returns trigger language plpgsql set search_path = public as $$
begin raise exception '% is append-only', tg_table_name; end;
$$;
create or replace function public.prevent_capital_advisor_truncate()
returns trigger language plpgsql set search_path = public as $$
begin raise exception '% is append-only and cannot be truncated', tg_table_name; end;
$$;
do $$ declare t text; begin
  foreach t in array array['capital_profile_snapshots','capital_decision_runs'] loop
    execute format('drop trigger if exists %I_append_only on public.%I', t, t);
    execute format('create trigger %I_append_only before update or delete on public.%I for each row execute function public.prevent_capital_advisor_mutation()', t, t);
    execute format('drop trigger if exists %I_no_truncate on public.%I', t, t);
    execute format('create trigger %I_no_truncate before truncate on public.%I for each statement execute function public.prevent_capital_advisor_truncate()', t, t);
    execute format('revoke update, delete, truncate on public.%I from service_role', t);
  end loop;
end $$;

do $$ declare jid bigint; begin
  for jid in select jobid from cron.job where jobname = 'kairos-capital-area-snapshots' loop
    perform cron.unschedule(jid);
  end loop;
end $$;
select cron.schedule('kairos-capital-area-snapshots','45 10 * * 0',
  $$select public.kairos_call_agent('/api/capital-advisor/area-snapshots', '{}'::jsonb, 'POST', 30000)$$);
