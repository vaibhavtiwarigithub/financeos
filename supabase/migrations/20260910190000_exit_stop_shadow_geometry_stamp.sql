-- Record WHICH exit geometry each ATR stop-shadow run actually measured.
--
-- THE DEFECT THIS FIXES. lib/trading/exit-stop-shadow.ts hardcoded its baseline
-- arm as { stopPct: 0.075, targetPct: 0.192 } with the comment "the live
-- configuration, exactly as deployed". It was not: the owner set
-- trading_mandates to stop 7% / target 8% on 2026-08-03, and this module was
-- written a month later. So NEITHER arm reflected production.
--
-- The target is the damaging half. At a 19.2% target against a real 8%, almost
-- every simulated trade resolves by stop or timeout instead of target -- exactly
-- the regime in which changing the stop looks most consequential. An effect
-- measured there does not transfer to the deployed book, and nothing on the row
-- recorded the assumption, so a later reader could not tell.
--
-- The shadow now reads the live mandate per market. These columns stamp what was
-- used, so "measured against the deployed geometry" becomes checkable rather
-- than asserted in a comment.
--
-- matches_live_mandate DEFAULTS FALSE deliberately: the rows already in this
-- table (2026-09-06, one per market) were computed against the stale hardcoded
-- baseline. They are left in place rather than deleted -- they are real
-- measurements of a real geometry, just not the deployed one -- and this flag
-- is what marks them non-transferable.
alter table public.exit_stop_shadow_runs
  add column if not exists baseline_stop_pct numeric,
  add column if not exists baseline_target_pct numeric,
  add column if not exists candidate_stop_atr numeric,
  add column if not exists matches_live_mandate boolean not null default false;

comment on column public.exit_stop_shadow_runs.matches_live_mandate is
  'True only when the baseline arm was built from trading_mandates for this market at run time. False marks a run whose baseline was the stale hardcoded fallback -- its result cannot be transferred to the live book.';
