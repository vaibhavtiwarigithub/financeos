# Historical data reader and cohort audit

Read-only production schema/size queries and a source search of `app/`, `lib/`, and `components/`, 2026-11-16. This is a planning audit, not deletion authorization.

## Production storage leaders

| Table | Relation bytes | Table/TOAST bytes | Index bytes | Rows from exact count where queried | 180-day cohort |
|---|---:|---:|---:|---:|---|
| `price_cache_restatements` | 118,857,728 | 84,877,312 | 33,980,416 | 365,750 | 308,746 older |
| `symbol_daily_returns` | 90,562,560 | 37,453,824 | 53,108,736 | 261,678 | 179,398 older |
| `decision_observations` | 80,035,840 | 74,530,816 | 5,505,024 | 18,515 | 0 older |
| `price_cache` | 66,338,816 | 39,329,792 | 27,009,024 | 190,358 | 113,249 older |
| `research_packets` | 62,881,792 | 62,177,280 | 704,512 | 18,754 | 0 older |
| `observation_labels` | 46,333,952 | 37,617,664 | 8,716,288 | 45,424 estimated | Forward-label maturity applies |
| `evidence_records` | 45,481,984 | 33,472,512 | 12,009,472 | 77,167 | All `retrieved_at` values Jul 2–Nov 12, 2026 |
| `signal_score_history` | 42,033,152 | 40,034,304 | 1,998,848 | 18,559 | 0 older |
| `dimension_diagnostic_findings` | 39,870,464 | 36,446,208 | 3,424,256 | 1,360 estimated | Requires separate reader audit |
| `llm_council_runs` | 35,315,712 | 34,406,400 | 909,312 | 4,714 | Oct 12–Nov 12, 2026 |
| `av_cache` | 32,194,560 | 31,744,000 | 450,560 | 2,977 | Current entries inside existing expiry windows |
| `agent_signals` | 30,515,200 | 25,542,656 | 4,972,544 | 19,005 estimated | Active agent output |
| `llm_council_batches` | 28,893,184 | 27,762,688 | 1,130,496 | 4,721 | Oct 12–Nov 12, 2026 |
| `provider_call_ledger` | 28,237,824 | 17,784,832 | 10,452,992 | 6,383 estimated | Audit/cost ledger; separate review required |
| `edge_signals` + `edge_signal_inputs` | 48,406,528 | — | — | — | Linked learning evidence |
| `pipeline_stage_events` + `evidence_cache_v2` | 44,802,048 | — | — | — | Needs lifecycle and reader audit |

`pipeline_stage_events` is 22,577,152 bytes and `evidence_cache_v2` is 22,224,896 bytes (44,802,048 bytes combined). Relation sizes include indexes/TOAST and are not guaranteed reclaimed bytes. The production size query returned the top 40 relations; the archive candidate list above is intentionally selective and is not a complete deletion set.

## Direct application reader concentration

Source scan counts are exact literal `.from("table")` matches in these code directories; they exclude SQL functions/RPC bodies, generated code, alternate quoting, and external consumers.

| Table | Direct source matches | Representative readers / dependency |
|---|---:|---|
| `price_cache_restatements` | 0 | No direct TypeScript reader found. Append-only trigger and provenance/replay value still apply. |
| `symbol_daily_returns` | 5 | Event maturation, policy events, missed-opportunity analysis, India macro exposure, portfolio correlation. Historical rows are active analytics inputs. |
| `decision_observations` | 44 | Research, label maturation, journal/review, learning, risk, score/exit shadows, council and readiness paths. Production has 9 inbound foreign-key constraints from labels/council/shadow tables. |
| `research_packets` | 10 | Research agent, mentor/thesis, score point detail, journal and council/evaluation paths. `raw_data` is read for paper-trade context. |
| `observation_labels` | 27 | Maturation writes plus learning, calibration, risk, shadows, diagnostics, and evaluations. Incomplete forward labels must remain online. |
| `evidence_records` | 3 | Matches are writes through `lib/data/evidence.ts`; no app/lib/component reader found. Production SQL audit found no SQL view/function reader, zero FK dependencies, and only the enabled append-only update/delete guard trigger. Full 77,167-row snapshot was archived and cold-restore verified before truncating the live table. New writes remain enabled. |
| `dimension_diagnostic_findings` | 2 active read paths | Dashboard GET returns the newest 8 diagnostic runs with joined findings; measure-only improvement context reads findings attached to the newest 36 runs per market. Archived findings older than both windows; kept run headers and all reader-visible findings online. This data does not feed scoring or trading. |
| `llm_council_runs` | 21 | Multiple council, evaluation, and history consumers; not safe for table removal without adapter or cold-restore workflow. |
| `llm_council_batches` | 6 | Council lifecycle/history; coupled with run snapshots. |

## `symbol_daily_returns` query contract recheck

The live `public.get_rotation_return_cohort(text,text[],date)` function returns `(symbol, session_date, simple_return, available_at)`, filters by market, a symbol list of 1–20, and a lower date bound, then selects the latest `available_at` per symbol/session. A current live duplicate audit found no duplicate `(market,symbol,session_date,available_at)` groups, so the D1 reader's secondary `id DESC` tie-breaker does not change the current corpus. The D1 Worker now rejects rotation requests over 20 symbols to match that Postgres contract. Live table count remains 261,678 rows, max ID 4,256,041, with latest `created_at` 2026-11-12 14:01:46.97005+00. This validates the current snapshot bound, not continued freshness; a full mirror must be checked against a fresh source count before marking verified.

Other direct readers do not all share one query shape: event maturation and policy-event evaluation read complete bounded symbol/date windows; India macro exposure groups recent rows per symbol and depends on stored previous-session returns; missed-opportunity marks read raw closes; correlation uses a point-in-time `available_at` cutoff and latest row per symbol/session/basis; capital rotation uses the SQL RPC. Archive integration therefore needs one table-level merge/read contract per consumer and source fallback behavior that does not hide missing archive data. The server adapter alone does not make these application readers archive-aware.

## Findings that affect the target

- The three tables with substantial data older than 180 days (`price_cache_restatements`, `symbol_daily_returns`, `price_cache`) occupy about 275.8 MB total. That age-only plan cannot reduce a 1,099,115,667-byte database below 400,000,000 bytes.
- Most of the next-largest evidence tables were created/populated between June and October 2026, so they have no 180-day cohorts yet. Reaching the requested target will require a tested query/read path for younger history, payload-level cold storage, or another source of measurable physical savings. It cannot be achieved by extending a conservative date cutoff alone.
- `decision_observations` deletion must account for at least nine inbound FK constraints and matching dependent label/council/shadow rows. `ON DELETE` behavior must be read from exact constraints before any cohort proposal.
- Do not use estimated `n_live_tup` values as exact counts; the observed estimates for several recent tables are stale. Full counts above are authoritative only where explicitly labeled exact.
- The `pipeline_stage_events` and `evidence_cache_v2` combined size is 44,802,048 bytes; no savings calculation should rely on unmeasured table row bytes.

## Next safe implementation order

1. Finish the dependency and SQL-function audit for the lower-coupling evidence tables; capture exact count/date/null/FK behavior and all consumers.
2. Implement the private runtime archive reader/restore path and typed table-specific contracts before any cohort is pruned. Keep the R2 public domain disabled.
3. Export independently restorable, immutable cohorts with a verified catalog, checksums, bounds, and manifest; enforce the account-wide 8 GiB stop.
4. Prove query/evaluator parity on the same snapshot, then reclaim a bounded cohort and measure actual Postgres physical bytes before continuing toward 380 MB.

## Completed low-coupling pilot

`price_cache_restatements` historical rows were verified and pruned after a locked exact-membership check. The archive and prune receipt are in `ARCHIVE_INVENTORY.md`. The live table is now empty and 32,768 bytes while the trigger writer remains enabled for future rows. The whole database measured 980,290,707 bytes after the operation. The 365,750 archived rows remain privately recoverable but are not available to direct Kairos SQL queries unless restored to Postgres; the source audit found no application reader for this relation. No other cohort has been removed.

`evidence_records` was also verified as cold-only for current code: 77,167 exact rows, IDs 1–77,181, no SQL view/function or app reader, no FK, and one enabled append-only update/delete guard. Its exact contents matched the verified full backup, and a separate 2,627,533-byte gzip/COPY archive was restored from an R2 round-trip download into a clean local PostgreSQL database with an exact ordered row-content digest. Under an ACCESS EXCLUSIVE lock, production count/bounds/digest were asserted before truncation. The empty relation is 40,960 bytes; database size fell from 980,290,707 to 934,849,683 bytes. The insert path and guard remain. Restore into Postgres is required to query cold records; R2 is not an online query engine.

`dimension_diagnostic_findings` contains an exact 21,367-row cold set linked to runs 1–692. The two current read contracts use only findings for newest runs (8 total in the UI endpoint; 36 per market in improvement context). A restore-tested 2,490,557-byte gzip/CSV archive was downloaded from private R2 and matched its ordered content digest. Under ACCESS EXCLUSIVE locks on run and finding tables, the cold-set count, finding ID bounds, and full digest were asserted; only those findings were removed. The finding immutability trigger was disabled only for the transaction and re-enabled before commit; parent run rows and the `ON DELETE RESTRICT` FK remain. The latest 36-run online findings count and digest are unchanged. `VACUUM FULL (ANALYZE)` reduced relation size from 39,870,464 to 2,629,632 bytes and database size from 934,849,683 to 897,617,043. Cold findings require restore into Postgres for historic viewing.

## Verified preservation candidate: `symbol_daily_returns` — 2026-11-16 09:27 UTC

Production remains 858,123,411 bytes, writable. A data-only COPY archive was extracted from the verified full PG17 dump, independently restored locally, uploaded to private R2, downloaded, and restored again. Both restores match live production exactly: 261,678 rows, ID range 1–4,256,041, session dates 2017-02-23–2026-11-11, and ordered digest `846c84ce7217a485a509e13cc3539921`. Compressed bytes are 9,173,390; SHA-256 is `81ba0e1ea58cb879735594769666b7df85204981739907ca9d178b706769b1d2`. Five TS readers plus one SQL RPC still consume this data, so no rows were pruned. Current R2 inventory is 17 private objects / 171,918,854 bytes. This adds a verified recovery copy, not a runtime archive reader.

## Follow-up: current production state and expired evidence cache — 2026-11-16 09:06 UTC

Production measured 858,090,643 bytes at 09:17 UTC and remained writable. The full-backup cohort inventory was rechecked against live table counts and date bounds: only the old `symbol_daily_returns` and `price_cache` histories, plus the now-pruned restatement history, contribute meaningful rows beyond 180 days. The two still-live tables occupy about 156.9 MB combined; together with restatements they total about 275.8 MB, insufficient to reach 400 MB. `symbol_daily_returns` has five TypeScript readers and a SQL RPC, so it needs archive-aware reads before pruning.

The live `evidence_cache_v2` table initially had 3,717 rows and occupied 22,224,896 bytes. There were 671 rows still permitted as stale cache and 1,841 expired rows still visible to the India shadow-status reader's 45-day window. Exactly 1,205 rows were past both `stale_until` and 45 days since `fetched_at`; those rows accounted for 3,663,321 bytes of JSON payload and had no triggers or FK dependencies. After refreshing project metadata, the exact predicate was rechecked and deleted 1,205 rows; the verified full backup preserves the pre-prune snapshot. `VACUUM FULL (ANALYZE)` reduced the relation to 11,370,496 bytes and database size by 10,854,400 bytes. All 671 stale-usable rows and all 2,512 entries in the 45-day status window remain. Cleanup code now removes the eligible cohort in bounded daily batches and owner preview reports it; the branch is not deployed.

Content-preserving compaction recovered more space without changing rows: `price_cache` kept exactly 190,358 rows and shrank from 66,338,816 to 44,974,080 bytes (21,364,736 bytes); `llm_council_runs` kept 4,714 rows and shrank from 35,315,712 to 31,875,072 bytes (3,440,640 bytes); `agent_signals` kept 19,005 rows and shrank from 30,515,200 to 26,222,592 bytes (4,292,608 bytes). A compact of `llm_council_batches` preserved all 4,721 rows but increased its relation size by 344,064 bytes, so it did not improve the target. Database measured 858,123,411 bytes at 09:20 UTC, leaving 458,123,411 bytes to reach 400 MB. Current private R2 inventory is 14 objects / 162,742,209 payload bytes. Focused cleanup tests pass 8/8 and TypeScript passes. The 180-day archive ceiling remains about 275.8 MB; the target still requires reader-preserving cold storage for younger, actively consumed history or a different approved database placement.

## 2026-11-16 09:36 UTC — return-archive verification and cron retention

The `symbol_daily_returns` archive was extracted from the verified PG17 full snapshot and independently restored from local and R2-downloaded copies. Both match the live count (261,678), IDs (1–4,256,041), date range (2017-02-23–2026-11-11), and ordered digest `846c84ce7217a485a509e13cc3539921`. The five TS consumers and SQL RPC remain in service, so none of these rows were pruned.

Supabase `cron.job_run_details` was 12,328,960 bytes with 46,312 run records, and 41,207 records were older than seven days. Supabase's official Cron guide says run history is not cleaned automatically and documents a rolling seven-day cleanup. A dedicated immutable R2 archive of 41,152 rows older than the exact full-backup-minus-seven-day cutoff was restored and digest-checked from an R2 download. An exact count/bounds/digest gate then removed only those rows from the managed log table; seven days remain. `VACUUM FULL (ANALYZE)` reclaimed 10,993,664 whole-database bytes. A daily cleanup job is scheduled at 02:15 UTC, without changing the existing schedules; all 140 jobs are active. At 09:36:52 UTC the whole DB measured 847,129,747 bytes, still 447,129,747 bytes above the 400 MB target. The 19-object private R2 inventory totals 172,911,071 bytes.
