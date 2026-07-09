-- 130 — Generic benchmark columns on paper_performance (additive).
--
-- US already stored spy_nav/spy_return_pct/alpha_pct; India stored nothing (no
-- benchmark). Add provider-neutral bench_nav/bench_return_pct so BOTH markets
-- carry a benchmark: US = VOO (was SPY), India = NIFTY 50 (^NSEI). The legacy
-- spy_* columns are left intact for historical rows; the UI reads bench_*.
-- Nullable, no backfill — older rows simply have null bench_* until re-computed.

alter table public.paper_performance
  add column if not exists bench_nav        numeric,
  add column if not exists bench_return_pct numeric;

comment on column public.paper_performance.bench_nav is
  'Benchmark index level for this market/day (US=VOO, India=NIFTY ^NSEI). Provider-neutral successor to spy_nav.';
comment on column public.paper_performance.bench_return_pct is
  'Cumulative benchmark % return vs the first recorded bench_nav for this market. alpha_pct = total_pnl_pct - bench_return_pct.';
