# Production storage growth audit — November 10, 2026 (America/Chicago)

Read-only production SQL against FinanceOS project `dionkikgdmlaotvtbnfr`, measured November 11 04:49 UTC. No deletion, schema, provider, score, or trading change was made.

## Current size and limits

- `pg_database_size`: 1,039,813,779 bytes. The Supabase Free 500 MB quota and the owner's below-400 MB target remain breached. `default_transaction_read_only=off` at measurement time.
- `av_cache`: 827,392 bytes after the separately authorized emergency clear. The prior 608 MB cache was the largest identified physical growth and its removal restored write access, but it did not put the remaining database under quota.
- `price_cache_restatements`: 114,212,864 bytes, 352,024 rows. This is append-only replay provenance, not provider response cache.

## Steady growth and bursts

There is no stored daily `pg_database_size` series, so inserted-row counts are not exact historical disk usage. The owner's Supabase disk graph for November 3–10 showed a gradual rise; the current relation sizes and dated rows identify both a sustained producer and distinct bursts.

- Restatements commonly added about 5,000–7,000 rows per October weekday. They rose to 9,282 on October 30, 13,793 on November 2, 11,930 on November 3, and 13,810 on November 9. September 2 had a one-time 32,239-row provenance backfill, including 31,940 `unknown/unknown -> yahoo/adjusted` transitions.
- Of the November 9 restatements, 7,578 were Yahoo adjusted→Yahoo adjusted, 2,904 Upstox raw→Yahoo adjusted, and 1,898 Yahoo adjusted→Upstox raw. November 2 included 3,221 Upstox raw→Yahoo adjusted. These basis/provider flips are materially distinct events. The India prewarmer in `lib/chart-data.ts` selects Upstox when it has the required session and Yahoo otherwise, then upserts the chosen provider's entire returned history on `(symbol,date)`; this is a plausible cause to validate with run-level evidence before changing the writer.
- On November 9, 6,411 restatements were Yahoo adjusted→Yahoo adjusted, close-only, with relative close drift below 0.0001% and no OHLC/volume change. Across the ledger, 217,615 such tiny close-only events concern bars at least 60 days old. A prospective, fail-closed precision policy could avoid most of this write amplification while preserving current bars and material restatements; it needs an approved design and regression validation.
- `symbol_daily_returns` also added 1,499–4,426 rows on many recent days; `research_packets` and `decision_observations` added roughly 200–250 rows on active weekdays. These are normal durable label/research/decision producers, not safe blanket pruning candidates.

## Repeated transition audit

Of 352,024 restatement rows, 184,792 have distinct exact transition payloads across `(symbol,date,old/new OHLCV,old/new provider,old/new basis)`, leaving 167,232 payload repeats at different detection times. The table intentionally records every occurrence so a sealed historical replay can prove what changed after its run. A repeated payload is not necessarily a duplicate event. Its append-only trigger rejects update/delete. Deleting these rows without a full verified restore and a replacement replay contract would erase provenance and, even at the table's average footprint, could save only about 54 MB before physical reclaim. Do not delete them as emergency cache.

## Other large relations

The largest remaining relations include `symbol_daily_returns` 89.6 MB, `decision_observations` 77.7 MB, `price_cache` 65.8 MB, `research_packets` 61.2 MB, `observation_labels` 45.4 MB, `evidence_records` 44.6 MB, `signal_score_history` 40.6 MB, `dimension_diagnostic_findings` 39.3 MB, and `llm_council_runs` 32.7 MB. Their payloads support point-in-time labels, evaluations, scores, and auditability. A size ranking alone is not a deletion policy.

## Next safe actions

1. Trace the Upstox/Yahoo basis oscillation by symbol, session, and scheduled writer; fix only the verified writer defect with tests while preserving provider timestamps and provenance.
2. Specify and validate a narrowly scoped prospective Yahoo adjusted close precision rule. The measured 0.0001% candidate captures almost all tiny-close noise; raising it to 0.1% would catch only about 3,028 additional events while accepting much larger differences.
3. Obtain a consistent full database backup and isolated restore proof before removing durable history. Build per-table archive/read-path contracts. The current SQL connector is diagnostic access, not a full restore artifact; the local DB URL still has a password placeholder. The owner requested no further password prompts.
4. Record daily database and relation sizes in the existing natural health cycle to replace row-count inference with actual growth measurements, and flag projected quota breaches. No new paid plan or service is permitted.

## Follow-through in progress

Production restatement timestamps for `BANKBARODA.NS` on November 9 show 213 Yahoo→Upstox rewrites around 07:00 UTC and 214 Upstox→Yahoo rewrites around 10:35 UTC. `lib/chart-data.ts` prewarms India from Upstox when the required session exists and otherwise from Yahoo, then upserts the provider's entire returned history. A focused test reproduced the old-bar cross-basis overwrite. The prospective app repair now reads existing basis for each bounded batch and skips only historical rows with a different basis. It still writes new/current sessions and same-basis historical restatements; a failed provenance read fails the prewarm. The repair is local until the release gates and exact production deployment are verified. This prevents a portion of future amplification but does not reclaim existing ledger rows or satisfy the 400 MB target.

The 07:00 UTC rewrite coincides with a persisted India research run. The 10:35 UTC rewrite coincides with the scheduled India Markets retry, but that route writes `india_market_snapshot` and has no direct `price_cache` writer. The restatement ledger has no writer/run identifier, so the exact caller of that later Yahoo rewrite is unproven. `fetchPriceHistory()` is another `lib/chart-data.ts` writer reachable through chart/research price routes; its NSE writes now use the same historical-basis guard. Natural post-deployment restatement counts and provider transitions are required to establish whether any other path remains.
