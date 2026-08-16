# Remediation Plan: Evaluation & Money-Path Integrity

**Status:** DRAFT — awaiting owner approval
**Author:** Claude (Architect, per AGENTS.md)
**Date:** 2026-08-16
**Inputs:** `INCIDENT_AND_PROPOSAL.md`, `CODEX_REVIEW.md`, addenda 1–2, live production sweep

---

## 0. The governing principle

Five separate checks in this incident could only ever report green:

| # | Check | Why it can't fail |
|---|---|---|
| 1 | `label-maturation` response | returns `success:true` with `matured:0, skipped:800` |
| 2 | `agent_runs.status` | records `done` for that same zero-output run |
| 3 | `stale-check` | asks "did it run", never "did it produce" |
| 4 | NAV invariant | compares an expression with itself |
| 5 | `agent_runs.status='error'` | faithfully written, nothing reads it |

**Therefore every workstream below ships with its own detector.** A fix without a
check that fails when the fix regresses is not done. This is the direct answer to
"ensure these don't happen again" — the defects were not exotic, they were
*invisible*.

---

## Completed 2026-08-16 (data repair only — no code changed)

| Action | Result |
|---|---|
| 9 open positions restated at true execution-date prices, notional preserved | lot/position parity 11/11 OK |
| XAR weighted-average across 1 stale + 2 clean lots | avg_cost 282.2210 |
| 5 closed stale-fill trades tainted, `realized_pnl` left intact | cash ledger drift **$0.00** |
| `paper_performance` taint columns (migration `paper_performance_taint_columns`, applied + verified) | 15 US rows Jul 27–Aug 14 tainted |
| `paper_portfolio.nav` recomputed | 10,047.14 → **9,974.94** |

**Corrected truth: the US paper book is −0.25% since inception, not +0.47%.**

The causing defects are all still live. Data repair without code repair means the
next fill re-contaminates the book.

---

## W1 — P0 — Stale quotes must never reach a fill or an order

**Defect.** `lib/data/quotes.ts` correctly returns `stale=true`, and callers drop it.

- `paper-trade/route.ts:378-381` rejects only `source==='unavailable'`; ignores `stale`
- `paper-trade/route.ts:372-376` (India) same
- `paper-trade/route.ts:992-1000` writes `current_price` on any positive price
- `lib/trading/execute-order.ts:312-318` names it a "fresh quote", keeps only `price`, discards `stale`/`source`/`retrievedAt` **before notional and price-drift validation** — reachable from the manual `/api/broker/orders` path

**Proven impact.** 15 US fills off a frozen cache, quotes as-of 2026-07-22 (LNC
2026-05-26), errors to **19.6%** (MSFT filled 391.97 vs real 487.65), $424.53
unrecorded value on a $10k book. India: 0 affected (97 trades, all zero lag).

**Fix.** Make freshness a required typed result at the boundary, not a caller
courtesy. Reject `stale`, `unavailable`, invalid/missing `retrievedAt`, and
wrong-market quotes inside `executeApprovedOrder` and every PaperTrader entry
path (US + India). Persist `price_source` and the true market-session timestamp
on every accepted fill and mark. Fail closed: no quote ⇒ no fill.

**Detector.** A fill whose `price_retrieved_at` precedes its session open is
impossible by construction; add a CHECK or trigger asserting
`executed_at - price_retrieved_at` is within one trading session, so the DB
refuses what the code should already have refused.

**Verification.** Cross-market unit tests (fresh accept / stale reject /
missing-timestamp reject); replay the LNC scenario and assert refusal; then
`select count(*) from paper_trades where price_source='price_cache'` stays flat.

---

## W2 — P0 — Partial exits are structurally impossible

**Defect.** `execute_paper_exit` represents a partial exit by cloning a residual
`order_side='buy'` lot. The anti-pyramiding trigger
(`20260806203000_prevent_paper_alpha_pyramiding.sql:60-88`) rejects it because
the position is, by definition, still open. **Codex found two further failures
behind it:** the clone preserves `paper_event_id` and `(market, signal_id)`,
both uniquely indexed (same migration, lines 48-58). Trigger exemption therefore
cannot work.

**Proven impact.** `execute_paper_exit failed (LNC): existing_open_position` on
2026-08-13 and 2026-08-14. Each aborted the **entire** US run
(`position-monitor/route.ts:254` throws), so stops went unevaluated for every
remaining holding and the EOD mark/NAV write was skipped.

**Fix (Codex's, adopted over my three alternatives).** Stop modelling a partial
exit as a second buy. Keep one immutable entry lot; record exits in an
append-only exit-fill ledger; derive remaining qty as entry minus exit fills;
close the entry lot when remaining reaches zero.

**Interim, same day:** convert partial-target to a full-target exit so no session
can repeat the abort while W2 is built.

**Also:** per-symbol error isolation. One symbol's exit failure must not abort
the book run — catch, raise a critical alert, mark the run `partial_failure`,
continue evaluating independent holdings. Returning overall success would be
equally wrong.

**Detector.** The run-state contract in W6 (`partial_failure` is a first-class
state that alerts).

**Verification.** Real Postgres integration test (ephemeral Supabase or pgTAP):
seed pool + alpha position + open lot, call `execute_paper_exit` at half
quantity, assert success, exact remaining qty, one cash credit, one append-only
exit fill, lot reconciliation, uniqueness, retry idempotence. Plus a route test
proving a later symbol is still evaluated after one symbol fails.

**Note.** `tests/paper-fill-integrity.test.ts:16-21` asserts the migration *text
contains a string*. It is shaped like coverage and is not coverage. Replace it.

---

## W3 — P1 — The actual cache root cause (my CLAIM A was wrong)

**Defect.** I attributed the frozen cache to label-maturation's fallback. Codex
refuted this with production timestamps: the Jul 22 batch was written by
**ResearchAgent's prewarm**, and `app/api/agents/research/cron/route.ts:621-624`
fires `prewarmPriceCache(...).catch(...)` **unawaited, immediately before the
response**. Unawaited work after a serverless response is not a durable job. It
completed on Jul 22 and never reliably again.

**Fix.** Replace with a durable, awaited, bounded job or a separately scheduled
queue consumer. Add writer/source/as-of provenance columns to `price_cache` —
current rows cannot be attributed without timing inference.

**Detector.** Per-symbol freshness contract (W6). Note the aggregate
`max(date)` read healthy at Aug 13 while **101 of 140 symbols sat at Jul 22** —
so the contract must be per-symbol over the traded universe, not table-wide.

---

## W4 — P1 — NAV marks have no provenance and no real invariant

**Defects.** CLAIM D, E, F all CONFIRMED.

- `position-monitor/route.ts:481-493` — `newNav` and `invariantExpected` are the
  same expression over the same array. `invariantDiff` is structurally zero.
- Positions only update when a fresh quote exists, so NAV silently blends
  fresh and stale marks of different ages.
- `paper_positions.current_price` is mutated in place; `paper_nav_history` keeps
  aggregates only. **A bad mark is unrecoverable within a day.**
- Aug 12 showed +2.70% then −2.97%. Codex fetched real closes: those 9 positions
  moved **−0.48%**, not +5.28%. The round trip is not market P&L.

**Fix.**
1. Replace the no-op with independent contracts: every open qty has a mark;
   every mark carries source + market-session timestamp; stale/unavailable weight
   is explicit; persisted `paper_portfolio.nav`, `paper_performance.nav`, cash
   ledger and mark snapshot reconcile *after* write.
2. Append-only `paper_position_marks` (run/session/position, qty, mark, source,
   provider timestamp, stale flag, reason). Thousands of rows/year at this size.
3. One canonical EOD performance writer per market. Premarket/intraday snapshots
   become separate typed rows and must never overwrite the EOD row.

**Still unresolved:** the Aug 12 spike cannot be attributed retrospectively —
the provenance to explain it was never written. The ledger prevents a repeat; it
cannot recover the past. **This stays open permanently.**

---

## W5 — P1 — Benchmark observations are session-mislabelled

**Defect.** My CLAIM C was half right. Narrow claim CONFIRMED — the scorecard
does not read frozen VOO cache rows. But "the reported 1M figure is sound" is
**REFUTED**: `bench_nav` 708.42 is VOO's **Aug 11** close, stored under both
Aug 12 and Aug 13. `paper-trade/route.ts:1037-1050` and
`position-monitor/route.ts:555-569` accept any positive benchmark quote,
ignoring `stale`, source, and true session date; the writer labels every positive
number `source_status='ok'`.

**Fix.** Build daily benchmark observations from session-dated daily bars and
persist the bar's own date and source. Join NAV to benchmark only when both
represent the same market close. Never infer observation date from the cron run
date. Clamp displayed coverage to 100% (US 1M currently reports 104.5%).

**Consequence to state plainly:** every US relative-performance figure quoted
this session is void until W4 + W5 land. The −2.98% vs VOO cannot be trusted.

---

## W6 — P1 — Monitoring: run accounting, not liveness

**My `assertProductiveRun` was REFUTED and I accept it.** Zero output is often
correct: no qualifying signal, no exits needed, no new research.

**Adopt Codex's typed contract:**

```
state    = no_work | completed | partial | blocked | failed
eligible = succeeded + expected_skip + deferred + unavailable + failed
```

Every job emits reasoned counts and a high-watermark. Alert on: any failed row;
impossible reconciliation; `eligible > 0 && succeeded == 0` with a blocker
reason; a high-watermark that does not advance within its grace window.
Business metrics (`trades_filled`, `positions_closed`) are telemetry, never
health criteria.

**Plus:** `stale-check` must reject `status='error'` — it currently counts the
two failed PositionMonitor runs as healthy.

**Two layers, both needed.** A versioned in-code registry for cross-run freshness
contracts (table/view, market scope, high-watermark, grace, minimum coverage)
AND typed per-job assertions for within-run reconciliation. A mutable DB table
alone cannot encode heterogeneous legitimate-skip semantics and would move
critical logic outside code review.

**This workstream is what would have caught items 1–5 in §0 on day one.**

---

## W7 — P1 — Label maturation

**Defect.** `label-maturation/route.ts:33-59` returns any non-empty cached slice,
so the provider fallback is unreachable when data is stale-but-present. Codex
also found a second bug I missed: the memo at lines 110-123 is keyed
`market:symbol` but spans **all horizons**, so an h2 request's narrow `sinceDate`
can starve a later h20 backlog.

**Fix.** Test required forward-session coverage, not row existence or count.
Fetch and merge provider candles when the decision/horizon window is incomplete.
Make the memo range-aware (or hold a full resolved series).

**Provider prerequisite CONFIRMED by Codex:** `fetchUsCandles` returns 251 Yahoo
bars through Aug 14 for AAPL/AVGO/VOO. The fallback works once reachable.

**Verification.** Drain the 1,738 US / 448 India backlog; assert labels exist
beyond 2026-07-22 and the high-watermark advances.

---

## W8 — P2 — Starvation

**My `label_attempts` column was REFUTED** — one counter cannot distinguish a
transient h20 shortage from a permanent h2 failure, and would exclude valid work
for the wrong horizon.

**No migration first:** separate scan budget from success budget (page past
skips until 200 labels produced or a bounded scan cap); group by market/symbol
and fetch once; split capacity between oldest work and a rotating cursor; emit
skip counts by reason and symbol. Only if permanent failures survive the W3/W7
repairs, add a horizon-scoped retry ledger keyed `(observation_id, horizon_days)`.

---

## W9 — P2 — Remaining stale-data consumers

| Consumer | Defect | Action |
|---|---|---|
| `lib/portfolio/inputs.ts:29` | 21 closes, no staleness check → PaperTrader sizing; frozen symbols return a permanently fixed vol | Require coverage + freshness; fall back explicitly |
| `rescore-check` | treats latest cached row as current; **can publish false learner feedback** | Coverage/as-of validation |
| `lib/data/benchmark-series.ts` | no recency check; beta/RS silently freeze if the ETF fill fails | Return `asOf`/stale status, not a bare array |
| `supabase/functions/_shared/quotes.ts` | divergent rule: uses `cached_at`, treats all off-hours cache as fresh; no active import | Delete or align before any reuse |
| deep-dive, briefing, market quote routes | display/LLM context shows stale cache unlabelled | Label staleness in UI and LLM context |

---

## Sequencing

```
W1 (stale-quote gate)  ─┐
W2-interim (full-exit)  ├─ day 1, stops the bleeding
W6-partial (stale-check rejects error) ─┘

W3 (durable prewarm) ── with W1: together they close the loop.
                        W1 stops a stale quote becoming a fill;
                        W3 stops the cache freezing at all.

W2-full (exit-fill ledger)  → needs migration, verify applied
W4 (mark ledger + real invariant) → needs migration, verify applied
W5 (benchmark session alignment)
W7 (label coverage + memo)  → then drain backlog
W6-full (typed run accounting)
W8, W9
```

**W1 + W3 are the pair that stop recurrence.** Either alone leaves half the
mechanism armed.

Every migration (W2, W4, and W3's provenance columns) must be verified applied
against production before dependent code ships — the standing rule, and the one
that caught `20260728120000` being reported applied when it was not.

---

## Definition of done

Not "code merged". The system must prove, by its own checks:

1. no fill accepts a stale/unknown quote (W1 detector + zero new `price_cache` fills)
2. a partial exit succeeds, and one symbol's failure leaves others evaluated (W2)
3. per-symbol cache freshness holds across the traded universe (W3)
4. every open qty has a sourced, session-stamped mark and NAV reconciles after write (W4)
5. NAV and benchmark join only on matching closes (W5)
6. observation-label high-watermarks advance past 2026-07-22 (W7)
7. a zero-output or failed run raises an alert (W6)

## Permanently open

- **The Aug 12 +2.70% NAV spike.** Codex's independent price check refutes market
  P&L; the provenance needed to attribute it was never written. Unrecoverable.
- **Contaminated history Jul 27 – Aug 14.** Tainted, not rewritten. Any
  performance analysis over that window must exclude or caveat it.
- **India vs US scoring comparison is now in question.** India had zero stale
  fills; US had 15. The earlier finding that India's scorer works and the US one
  does not may have been this bug, not a scoring difference. Re-test after W7
  drains the backlog.
