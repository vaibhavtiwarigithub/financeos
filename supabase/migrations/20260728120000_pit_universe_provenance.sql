-- Step 4 of features/walk-forward-ic-folds: point-in-time universe provenance.
--
-- edge_universe_members already records the exact symbol set used for a run, but
-- migration 132 states in its own header that it does NOT claim point-in-time
-- membership — it recorded a current-liquid snapshot. Replaying today's survivors
-- through past dates is survivorship bias, and it is why promotion is dormant.
--
-- This migration does NOT create a parallel universe table. It adds the
-- provenance that turns an existing row into evidence, and makes the honest
-- default explicit: is_point_in_time is FALSE unless a PIT source proved it.

alter table public.edge_universe_members
  -- FALSE means "this row is a current-universe snapshot, not PIT evidence".
  -- Every pre-existing row is exactly that, so the default backfills correctly.
  add column if not exists is_point_in_time  boolean not null default false,
  -- massive_pit_tickers | curated_current | nse_archive
  add column if not exists membership_source text,
  -- Version of the PIT policy that selected this member (rules + thresholds).
  add column if not exists pit_policy_version text,
  -- Was the security actually trading on as_of_date, per the membership source?
  add column if not exists active_on_as_of   boolean,
  -- Non-null when the name later delisted. Its PRESENCE in an old snapshot with
  -- a delisted_at in the future of as_of_date is the survivorship fix working.
  add column if not exists delisted_at       date,
  -- Point-in-time liquidity, computed from data <= as_of_date only.
  add column if not exists adv_value         numeric,
  add column if not exists adv_rank          integer,
  -- Deterministic hash of the full member set for this (universe_id, market).
  -- Two runs of the same policy on the same date must produce the same value.
  add column if not exists snapshot_fingerprint text;

comment on column public.edge_universe_members.is_point_in_time is
  'FALSE = current-universe snapshot (survivorship-biased, NOT promotion evidence). '
  'TRUE = membership resolved from a point-in-time source as of as_of_date. '
  'The promotion gate must refuse any experiment whose universe rows are FALSE.';

comment on column public.edge_universe_members.delisted_at is
  'Set when the membership source reports the security later delisted. A row with '
  'delisted_at > as_of_date is a name that WAS tradeable then and is gone now — '
  'exactly the observation a current-universe snapshot silently drops.';

-- A PIT snapshot is keyed by (market, as_of_date, policy). Enforce that a given
-- policy cannot write two different member sets for the same market/date.
create unique index if not exists edge_universe_members_pit_uidx
  on public.edge_universe_members (market, as_of_date, pit_policy_version, symbol)
  where is_point_in_time;

-- Fast lookup of one PIT snapshot.
create index if not exists edge_universe_members_pit_lookup_idx
  on public.edge_universe_members (market, as_of_date, pit_policy_version)
  where is_point_in_time;
