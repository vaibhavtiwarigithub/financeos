# FinanceOS measured database size

Read-only production measurements from Supabase project `dionkikgdmlaotvtbnfr`. Bytes are `pg_database_size(current_database())`, not the dashboard's total disk percentage. The existing Kairos completion watchdog checks this once daily; within-day probes below seed the record and must not be extrapolated into a daily growth rate.

| Measured at (UTC) | Database bytes | `av_cache` bytes | `price_cache_restatements` bytes | Default read-only | Notes |
|---|---:|---:|---:|---|---|
| 2026-11-11 04:49:29 | 1,039,813,779 | 827,392 | 114,212,864 | off | Post-emergency cache clear; still above Free-plan quota and 400 MB target. |
| 2026-11-11 05:37:41 | 1,040,067,731 | 901,120 | 114,212,864 | off | Same-day diagnostic; next natural India refresh has not verified the deployed basis guard. |

The daily watchdog should append actual measurements, assess relation-level growth, and report a projected threshold only after a meaningful interval and stable observations. A successful cleanup job or writable database is not proof of Free-plan quota compliance.
