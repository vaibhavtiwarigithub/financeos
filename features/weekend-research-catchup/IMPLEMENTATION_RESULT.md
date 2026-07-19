# Market-Closed-Day Research Catch-up — Implementation Result

Completed: 2026-07-19

## Shipped behavior

- US and India catch-up triggers run daily after prewarm and self-skip unless the
  exchange is closed for a supported weekend or full holiday.
- Catch-up reads only each market's carry-forward `research_queue`.
- Scores are written under the legacy `weekend_staged` status with
  `session_validated=false` and the
  last completed market session.
- Successfully staged candidates remain queued for next-session revalidation.
- A session success writes a new validated row and retires the staged row.
- PaperTrader and TraderAgent require positive session validation.
- AutonomousShadow, AutonomousLive, and CapitalRotation direct signal reads
  require the same positive validation proof.
- PositionMonitor ignores staged scores for conviction exits; mechanical exits
  remain active and unchanged.
- Agents → Capacity reports queue/workload type, pending preparation, staged
  work, recent median throughput, configured ceiling, oldest age, and estimated
  clearing days separately for US and India.

## Production proof

Supabase project `dionkikgdmlaotvtbnfr`:

- `agent_signals.session_validated boolean not null default true`
- `agent_signals.as_of_session date`
- `agent_signals.staged_at timestamptz`
- `agent_runs.workload_metrics jsonb`
- validated `agent_signals_weekend_stage_unvalidated` CHECK
- partial unique `agent_signals_one_weekend_stage_per_symbol`
- active `kairos-closed-day-research-us` at `10 15 * * *`
- active `kairos-closed-day-research-india` at `10 5 * * *`
- old `kairos-weekend-research-*` jobs absent
- migration tracker contains `market_holiday_research_catchup`
- 2026 calendar sources: NYSE trading calendar; NSE Capital Market circular
  CMTR71775 plus amendment CMTR72260
- all 538 pre-existing signals remained `session_validated=true`

Live Sunday run after deployment:

- US: 26 queued candidates processed, 26 staged, 0 failed
- India: 4 queued candidates processed, 4 staged, 0 failed
- every staged row: `as_of_session=2026-07-17`,
  `session_validated=false`
- queues remained US 26 / India 4 for the next session revalidation
- zero PaperTrader runs, zero paper trades, zero trade proposals, and zero
  `session_validated=false AND status='pending'` rows after the run

## Verification

- `npx tsc --noEmit`: pass
- `npx vitest run`: 1,106 pass, 6 skip
- `npm run build`: pass; fresh `.next/BUILD_ID` generated
- `ggshield secret scan pre-commit`: no secrets
- Vercel deployment for `bc4bcb3a`: Ready before cron migration applied

No live order, paper fill, position mutation, Router activation, provider-policy
change, or cross-market aggregation was performed by this implementation.
