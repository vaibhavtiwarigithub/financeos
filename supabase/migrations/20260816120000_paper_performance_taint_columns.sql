-- Applied to production 2026-08-16 via MCP as `paper_performance_taint_columns`
-- and verified through information_schema. This file exists for repo/DB parity.
--
-- Why: performance rows can be computed from contaminated inputs. On 2026-08-16
-- a sweep found 15 US paper fills priced off a frozen price_cache (quotes as-of
-- 2026-07-22; LNC 2026-05-26) with price errors up to 19.6%. Without an explicit
-- marker the only choices are to silently keep a wrong number or to rewrite
-- history. Both are worse than labelling the row.
--
-- Rows are preserved as-recorded and never rewritten: `realized_pnl` on the
-- affected trades was deliberately left intact so the cash-ledger reconciliation
-- (cash = seed - open_cost + realized) continues to hold at $0.00 drift.

alter table public.paper_performance
  add column if not exists tainted boolean not null default false,
  add column if not exists taint_reason text;

comment on column public.paper_performance.tainted is
  'True when this row was computed from inputs later found to be corrupt (stale fills, bad marks, mislabelled benchmark sessions). The row is preserved, never rewritten.';
comment on column public.paper_performance.taint_reason is
  'Human-readable provenance for the taint, including the contaminating defect and its window.';
