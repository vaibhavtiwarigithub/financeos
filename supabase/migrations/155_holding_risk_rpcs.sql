-- Daily Per-Holding Risk Analytics — claim + publish RPCs.
-- Spec: features/holding-risk-daily/FEATURE_ARCHITECTURE.md.
--
-- Two SECURITY DEFINER functions (service_role only), mirroring the hardening pattern of
-- migration 153 (advisory lock scoped to the query, finite-numeric validation, REVOKE public/anon/
-- authenticated + GRANT service_role, fixed search_path):
--
--   claim_holding_risk_run   — idempotent run claim. Advisory-locks on run_key, INSERTs the run row
--                              at status='running'. A concurrent/retried cron loses the unique-insert
--                              race and reads the existing run back (never a duplicate, never
--                              check-then-insert). Returns (run_id, status, is_new).
--
--   publish_holding_risk_run — transactional finalize. In ONE function body (== one transaction):
--                              inserts every per-holding snapshot + the account roll-up, then
--                              transitions the run running→terminal. Any error rolls the whole thing
--                              back and the run stays 'running' (nothing published as latest). Row
--                              IDENTITY (market/currency/broker/account_id/captured_on/formula_version)
--                              is taken from the RUN ROW, not the caller's holdings payload, so a
--                              holdings blob can never inject a foreign account/currency. Never upserts.
--
-- Idempotent: CREATE OR REPLACE + re-asserted REVOKE/GRANT.

begin;

-- Reject non-finite numerics extracted from a jsonb payload. NULL passes (optional field);
-- 'NaN'/'Infinity'/'-Infinity' fail closed. Range checks are enforced by the table CHECK constraints.
create or replace function public.hr_num(p jsonb, k text)
returns numeric
language plpgsql
immutable
as $fn$
declare v numeric;
begin
  if p is null or p->>k is null then return null; end if;
  v := (p->>k)::numeric;
  if v = 'NaN'::numeric or v = 'Infinity'::numeric or v = '-Infinity'::numeric then
    raise exception 'non_finite_numeric: field % = %', k, p->>k using errcode = 'P0001';
  end if;
  return v;
end
$fn$;

-- ── claim_holding_risk_run ─────────────────────────────────────────────────────
create or replace function public.claim_holding_risk_run(
  p_run_key         text,
  p_market          text,
  p_currency        text,
  p_broker          text,
  p_account_id      text,
  p_account_label   text,
  p_captured_on     date,
  p_formula_version text
)
returns table (run_id uuid, status text, is_new boolean)
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_id uuid;
  v_status text;
begin
  if p_run_key is null or length(btrim(p_run_key)) = 0 then
    raise exception 'invalid_run_key: must be non-empty' using errcode = 'P0001';
  end if;
  if p_market not in ('us', 'india') then
    raise exception 'invalid_market: % (expected us|india)', coalesce(p_market, '<null>') using errcode = 'P0001';
  end if;
  if not ((p_market = 'us' and p_currency = 'USD') or (p_market = 'india' and p_currency = 'INR')) then
    raise exception 'invalid_market_currency: % / %', p_market, coalesce(p_currency, '<null>') using errcode = 'P0001';
  end if;
  if p_broker is null or length(btrim(p_broker)) = 0 then
    raise exception 'invalid_broker: must be non-empty' using errcode = 'P0001';
  end if;
  -- Broker-verified account identity only. A placeholder (e.g. 'kite_india') must never claim a run.
  if p_account_id is null or length(btrim(p_account_id)) = 0 or p_account_id = 'kite_india' then
    raise exception 'invalid_account_id: must be a broker-verified account identity' using errcode = 'P0001';
  end if;
  if p_captured_on is null then
    raise exception 'invalid_captured_on: must be a session date' using errcode = 'P0001';
  end if;
  if p_formula_version is null or length(btrim(p_formula_version)) = 0 then
    raise exception 'invalid_formula_version: must be non-empty' using errcode = 'P0001';
  end if;

  -- Serialize concurrent claims of the SAME run_key. Distinct run_keys hash distinct and never block.
  perform pg_advisory_xact_lock(hashtext(p_run_key));

  select id, holding_risk_runs.status into v_id, v_status
    from holding_risk_runs where run_key = p_run_key;

  if v_id is not null then
    run_id := v_id; status := v_status; is_new := false;
    return next;
    return;
  end if;

  insert into holding_risk_runs(
    run_key, market, currency, broker, account_id, account_label, status, captured_on, formula_version
  ) values (
    p_run_key, p_market, p_currency, p_broker, p_account_id, p_account_label, 'running', p_captured_on, p_formula_version
  )
  returning id into v_id;

  run_id := v_id; status := 'running'; is_new := true;
  return next;
end
$fn$;

-- ── publish_holding_risk_run ───────────────────────────────────────────────────
create or replace function public.publish_holding_risk_run(
  p_run_id             uuid,
  p_status             text,        -- 'complete' | 'failed' | 'partial'
  p_source_captured_at timestamptz,
  p_input_hash         text,
  p_data_confidence    numeric,
  p_missing_inputs     text[],
  p_error              text,
  p_holdings           jsonb,       -- array of holding objects (complete|partial)
  p_account            jsonb        -- account roll-up object (complete only)
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_run holding_risk_runs%rowtype;
  elem  jsonb;
  v_sym text;
begin
  if p_status not in ('complete', 'failed', 'partial') then
    raise exception 'invalid_status: % (expected complete|failed|partial)', coalesce(p_status, '<null>') using errcode = 'P0001';
  end if;
  if p_data_confidence is not null
     and (p_data_confidence = 'NaN'::numeric or p_data_confidence = 'Infinity'::numeric
          or p_data_confidence = '-Infinity'::numeric or p_data_confidence < 0 or p_data_confidence > 1) then
    raise exception 'invalid_data_confidence: must be finite in [0,1]' using errcode = 'P0001';
  end if;

  -- Serialize publish against this run; block a second finalize.
  perform pg_advisory_xact_lock(hashtext(p_run_id::text));

  select * into v_run from holding_risk_runs where id = p_run_id;
  if not found then
    raise exception 'unknown_run: %', p_run_id using errcode = 'P0001';
  end if;
  if v_run.status <> 'running' then
    raise exception 'run_already_finalized: % is %', p_run_id, v_run.status using errcode = 'P0001';
  end if;

  -- Insert per-holding snapshots. Identity columns come from the RUN, not the payload —
  -- the holdings blob supplies only per-symbol facts, never account/currency/market.
  if p_status in ('complete', 'partial') and p_holdings is not null and jsonb_typeof(p_holdings) = 'array' then
    for elem in select * from jsonb_array_elements(p_holdings)
    loop
      v_sym := elem->>'symbol';
      if v_sym is null or length(btrim(v_sym)) = 0 then
        raise exception 'invalid_holding: symbol required' using errcode = 'P0001';
      end if;

      insert into holding_risk_snapshots(
        run_id, captured_on, market, currency, broker, source, source_captured_at,
        account_id, account_label, symbol, sector,
        qty, current_price, average_cost, market_value, weight_pct,
        beta, realized_vol_pct, unrealized_pnl_pct,
        holding_risk_score, risk_label, risk_drivers, risk_posture, action_reason, add_capacity,
        data_confidence, missing_inputs, formula_version, strategy_note
      ) values (
        v_run.id, v_run.captured_on, v_run.market, v_run.currency, v_run.broker,
        elem->>'source', p_source_captured_at,
        v_run.account_id, v_run.account_label, v_sym, elem->>'sector',
        hr_num(elem,'qty'), hr_num(elem,'current_price'), hr_num(elem,'average_cost'),
        hr_num(elem,'market_value'), hr_num(elem,'weight_pct'),
        hr_num(elem,'beta'), hr_num(elem,'realized_vol_pct'), hr_num(elem,'unrealized_pnl_pct'),
        (hr_num(elem,'holding_risk_score'))::int, elem->>'risk_label',
        coalesce(elem->'risk_drivers', '{}'::jsonb), elem->>'risk_posture', elem->>'action_reason',
        coalesce((elem->>'add_capacity')::boolean, false),
        hr_num(elem,'data_confidence'),
        coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(elem->'missing_inputs','[]'::jsonb)) x), '{}'),
        v_run.formula_version, elem->>'strategy_note'
      );
    end loop;
  end if;

  -- Account roll-up (required for a complete run).
  if p_status = 'complete' then
    if p_account is null then
      raise exception 'invalid_account_rollup: required for a complete run' using errcode = 'P0001';
    end if;
    insert into account_risk_snapshots(
      run_id, captured_on, market, currency, broker, account_id, account_label,
      source_captured_at, metrics, total_value, data_confidence, missing_inputs, formula_version
    ) values (
      v_run.id, v_run.captured_on, v_run.market, v_run.currency, v_run.broker,
      v_run.account_id, v_run.account_label, p_source_captured_at,
      coalesce(p_account->'metrics', p_account, '{}'::jsonb), hr_num(p_account,'total_value'),
      p_data_confidence, coalesce(p_missing_inputs, '{}'), v_run.formula_version
    );
  end if;

  -- Finalize the run (running → terminal). Lifecycle trigger permits exactly this transition.
  update holding_risk_runs
     set status = p_status,
         completed_at = now(),
         source_captured_at = p_source_captured_at,
         input_hash = p_input_hash,
         data_confidence = p_data_confidence,
         missing_inputs = coalesce(p_missing_inputs, '{}'),
         error = p_error
   where id = p_run_id;
end
$fn$;

-- Definer functions are service-only.
revoke execute on function public.hr_num(jsonb, text) from public, anon, authenticated;
grant  execute on function public.hr_num(jsonb, text) to service_role;

revoke execute on function public.claim_holding_risk_run(text, text, text, text, text, text, date, text)
  from public, anon, authenticated;
grant  execute on function public.claim_holding_risk_run(text, text, text, text, text, text, date, text)
  to service_role;

revoke execute on function public.publish_holding_risk_run(uuid, text, timestamptz, text, numeric, text[], text, jsonb, jsonb)
  from public, anon, authenticated;
grant  execute on function public.publish_holding_risk_run(uuid, text, timestamptz, text, numeric, text[], text, jsonb, jsonb)
  to service_role;

commit;
