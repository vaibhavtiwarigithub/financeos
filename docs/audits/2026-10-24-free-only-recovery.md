# Free-only recovery, October 24

Owner mandate: never upgrade; reduce workload. No paid resources, history
deletion, inference test, manual order, trading-placing cron or brake reset.

## Verified repairs

- Applied 20261024122903: six council cron schedules */5 → */15; exact catalog
  readback confirmed all six. Commands, windows, IDs and active state preserved.
- Health reporting skips unchanged payload writes; changed issues remain loud.
  Lookup failures are logged, and updates guard against concurrent resolution.
- Cleanup and read-only preview no longer report success when PostgREST returns
  errors. Existing retention is unchanged; cleanup was not invoked in production.
- Home signal/run reads project only consumed columns. Production schema checked
  (agent_runs has no created_at; agent_signals has no action). A 30-recent-signal
  sample averaged 1,850 bytes per full row versus 221 bytes of home fields.
  This is a payload measurement, not a claimed 88% end-to-end latency reduction.
- Reproduced BRK.B provider bug: Yahoo chart BRK.B 404; BRK-B 200/five bars.
  One shared provider-only share-class translator fixes cached research and
  raw/adjusted replay candle adapters while retaining canonical evidence keys.
  India .NS/.BO suffixes and benchmark IDs are unchanged.
- Session-aware freshness alerts name the required completed session, rather
  than confusingly reporting a breach at 40 hours against a 96-hour rolling
  grace that is not the actual daily-bar rule. Gates are unchanged.
- Found why VOO alone stayed at October 22: the primary comparator's cache-hit
  branch checked the stale portfolio's date, not the scheduled expected session.
  The existing expected session is now the minimum provider target. This repairs
  independent benchmark collection without inventing the missing portfolio NAV.

## Production recovery evidence and limits

Supabase Auth/REST/admin SQL respond again. Natural cron execution resumed
(last sampled success 12:27 UTC, failures through 11:55 UTC). No restart or
session termination was performed; no exact root cause of recovery is claimed.

An authenticated price-only refresh through the existing kairos_call_agent
dispatcher returned HTTP 200: 159/160 US names current, BRK.B failed (fixed by
this release). Benchmark recovery collected October 23 marks but honestly
remained partial: canonical US portfolio EOD is missing. Do not invent its NAV,
relabel an intraday snapshot, or invoke PositionMonitor as a repair test.

Local CRON_SECRET does not authenticate production; Vercel correctly refuses
to export sensitive values. No secret was printed, rotated or overwritten.
The existing service-only dispatcher was reused for price/benchmark recovery,
read-only health evaluation, and the existing label-maturation producer.
The latter completed at 12:40 UTC: 737 matured labels, 240 skipped
(34 no-candles / 206 incomplete windows), ATR 732/737. Missing windows remain
missing; no inference or trading was involved.

Storage is still 1,299 MB. av_cache accounts for about 600 MB and has 28,078
superseded slots older than 45 days. No payload/history has been removed.
A separately reviewed cache/archive and reclamation plan is needed before
promising a smaller database; reducing reads cannot shrink retained history.
Supabase distinguishes database data/index size from total disk/WAL usage:
https://supabase.com/docs/guides/platform/database-size

Outstanding health must remain visible: US paper accuracy brake (30% vs 35%),
missing US EOD, missed/partial producers pending recovery proof, Kite owner
login, unavailable CASHCAT daily candles, and storage quota. Advisor findings
are not blanket-cleared. Free capacity and provider availability are not
guaranteed, and no missed historical decision is retroactively fabricated.

## Release verification

Focused tests, full suite, TypeScript, secret scan, exact remote SHA and Vercel
READY are verified before handoff. Runtime deployment does not itself prove
healthy natural collection or complete historical accounting.
