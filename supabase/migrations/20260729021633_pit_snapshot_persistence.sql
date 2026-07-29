-- Promotion-grade PIT universe snapshots: atomic, idempotent, append-only.
-- Measure-only. No policy, score, position, cash, or order path reads this RPC.

create or replace function public.edge_universe_members_protect_pit()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.is_point_in_time then
    raise exception 'point-in-time universe snapshots are append-only';
  end if;
  return new;
end;
$$;

drop trigger if exists edge_universe_members_protect_pit on public.edge_universe_members;
create trigger edge_universe_members_protect_pit
  before update or delete on public.edge_universe_members
  for each row execute function public.edge_universe_members_protect_pit();

create or replace function public.persist_edge_pit_snapshot(
  p_market text,
  p_as_of_date date,
  p_policy_version text,
  p_source text,
  p_fingerprint text,
  p_members jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $$
declare
  v_expected int;
  v_existing int;
  v_existing_fingerprints int;
  v_universe_id text;
begin
  if p_market <> 'us' then
    raise exception 'unsupported_market: only US PIT snapshots are currently supported';
  end if;
  if p_as_of_date is null or coalesce(trim(p_policy_version), '') = ''
     or coalesce(trim(p_source), '') = '' or coalesce(trim(p_fingerprint), '') = '' then
    raise exception 'invalid_snapshot_identity';
  end if;
  if jsonb_typeof(p_members) <> 'array' then
    raise exception 'invalid_members: expected a JSON array';
  end if;

  v_expected := jsonb_array_length(p_members);
  if v_expected < 1 or v_expected > 1000 then
    raise exception 'invalid_members: count % outside 1..1000', v_expected;
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_members) m
    where coalesce(trim(m->>'symbol'), '') = ''
       or (m->>'advRank') is null
       or (m->>'advValue') is null
       or (m->>'advRank')::int < 1
       or (m->>'advValue')::numeric <= 0
  ) then
    raise exception 'invalid_members: symbol, positive advValue and positive advRank are required';
  end if;
  if (
    select count(distinct upper(trim(m->>'symbol')))
    from jsonb_array_elements(p_members) m
  ) <> v_expected then
    raise exception 'invalid_members: duplicate symbols';
  end if;
  if (
    select count(distinct (m->>'advRank')::int)
    from jsonb_array_elements(p_members) m
  ) <> v_expected then
    raise exception 'invalid_members: duplicate ADV ranks';
  end if;

  perform pg_advisory_xact_lock(hashtext(
    'edge-pit:' || p_market || ':' || p_as_of_date || ':' || p_policy_version
  ));

  select count(*), count(distinct snapshot_fingerprint)
    into v_existing, v_existing_fingerprints
  from public.edge_universe_members
  where market = p_market
    and as_of_date = p_as_of_date
    and pit_policy_version = p_policy_version
    and is_point_in_time;

  if v_existing > 0 then
    if v_existing <> v_expected or v_existing_fingerprints <> 1
       or exists (
         select 1
         from public.edge_universe_members e
         where e.market = p_market
           and e.as_of_date = p_as_of_date
           and e.pit_policy_version = p_policy_version
           and e.is_point_in_time
           and e.snapshot_fingerprint is distinct from p_fingerprint
       )
       or exists (
         select 1
         from jsonb_array_elements(p_members) m
         where not exists (
           select 1
           from public.edge_universe_members e
           where e.market = p_market
             and e.as_of_date = p_as_of_date
             and e.pit_policy_version = p_policy_version
             and e.is_point_in_time
             and e.symbol = upper(trim(m->>'symbol'))
             and e.adv_rank = (m->>'advRank')::int
             and e.adv_value = (m->>'advValue')::numeric
         )
       ) then
      raise exception 'snapshot_conflict: an immutable snapshot already exists with different content';
    end if;
    return jsonb_build_object(
      'status', 'existing',
      'member_count', v_existing,
      'fingerprint', p_fingerprint
    );
  end if;

  v_universe_id :=
    'pit:' || p_market || ':' || p_as_of_date || ':' || p_policy_version || ':' || p_fingerprint;

  insert into public.edge_universe_members (
    universe_id, market, symbol, as_of_date, source, included_reason,
    is_point_in_time, membership_source, pit_policy_version,
    active_on_as_of, delisted_at, adv_value, adv_rank, snapshot_fingerprint
  )
  select
    v_universe_id,
    p_market,
    upper(trim(m->>'symbol')),
    p_as_of_date,
    p_source,
    'point_in_time_trailing_adv',
    true,
    p_source,
    p_policy_version,
    true,
    nullif(m->>'delistedAt', '')::date,
    (m->>'advValue')::numeric,
    (m->>'advRank')::int,
    p_fingerprint
  from jsonb_array_elements(p_members) m;

  return jsonb_build_object(
    'status', 'inserted',
    'member_count', v_expected,
    'fingerprint', p_fingerprint,
    'universe_id', v_universe_id
  );
end;
$$;

revoke all on function public.persist_edge_pit_snapshot(
  text, date, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.persist_edge_pit_snapshot(
  text, date, text, text, text, jsonb
) to service_role;
