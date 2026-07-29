# Historical Replay Harness — Frozen Point-in-Time Eligibility

> **STATUS: SUPERSEDED IN PART.** The sealed primitives were implemented. The
> parallel storage proposal below is historical context and is not authoritative
> for new bulk-data runs.

> New bulk-data experiments follow
> `features/local-historical-replay/FEATURE_ARCHITECTURE.md` and extend the existing
> immutable `backtest_experiments` ledger.

Last updated: 2026-07-29
Owner: Vaibhav
Requirement: `CLAUDE_CODE_POST_UPGRADE_FIX_PROMPT.md` — Required test **15**.

---

## 1. The requirement (verbatim)

> **Test 15:** "MU/INTC/SNDK/GME-style frozen historical packets run without future
> data and report whether/when each model becomes eligible — no handpicked future-return
> dates."

And its sibling, test 14 (the guard this harness must not violate):

> **Test 14:** "point-in-time label/universe fixtures cannot access future records."

Read together: build a replay that, for a handful of named symbols, freezes the world
as it was on a sequence of past as-of dates, runs the real scoring → calibration →
eligibility pipeline against each frozen slice, and reports **the first date each model
would have cleared its eligibility gate** — chosen by the pipeline, never cherry-picked by
a human who already knows the outcome.

The adversarial framing from the prompt applies: "Treat real money as adversarial." The
whole point of this harness is to make it *impossible* to accidentally answer "would this
model have caught the MU/INTC run-up?" with a number that secretly peeked at the run-up.

---

## 2. What "eligible" already means in this codebase

The harness does not invent an eligibility concept. It replays the gates that already
exist:

| Gate | Where it lives | What it decides |
|---|---|---|
| **Calibration OOS gate** | `lib/validation/calibration.ts` → `acceptCalibrationOOS()` / `fitAndStoreCalibration()` | A `pwin_logistic` model artifact is *accepted* only when its walk-forward holdout has ≥30 usable rows, non-degenerate outcomes, and ECE ≤ 0.1. Fail-closed. |
| **Validation Engine gates** | `lib/validators/backtest.ts`, `app/api/agents/backtest/route.ts` (per `docs/arch/09-learning-loop.md`) | Sharpe ≥ 0.5 and win rate ≥ 40% on walk-forward held-out slices → `eligibility_passed`. |
| **Edge IC classifier** | `lib/edges/ic.ts` → `classify()` | An edge is `shadow_eligible` only at meanIC ≥ 0.02 and \|t\| ≥ 2.0 with n ≥ 12. |
| **Thin-evidence / abstain gate** | `lib/scoring/weighted-score.ts` → `computeWeightedAnalystScore()`, `isThinEvidence()` | Score is meaningful only with ≥2 usable dimensions. |

"Model becomes eligible" in test-15 language = **the earliest as-of date at which one of
these gates flips from fail to pass, using only data dated ≤ that as-of date.** That is the
single number the harness reports per (symbol-cohort, model, setup, horizon).

---

## 3. What is already in place (reuse, don't rebuild)

The PIT machinery is largely built; this harness assembles frozen inputs *for* it.

- **Walk-forward with purge + embargo** — `lib/learning/dataset.ts` → `walkForwardFolds()`.
  Pure function, already unit-tested in `tests/walk-forward.test.ts` for the property that
  no train row's label window overlaps its fold's test window. This is the time-ordering
  spine.
- **Calibration replay** — `lib/validation/calibration.ts` fits a **separate** model on each
  fold's train partition and predicts only that fold's test partition (the file's own
  comment flags the prior full-data leak it fixed). ECE is computed on the holdout only.
- **As-of candle replay** — `lib/edges/ic.ts` → `computeEdgeIC()` already samples historical
  benchmark trading days as as-of dates and slices candle history up to each, leaving room
  for the forward horizon. This is the pattern to generalize.
- **Shared scoring contract** — `lib/scoring/weighted-score.ts` guarantees the replay scores
  a candidate with the *exact* rule ResearchAgent runs live (the module exists precisely so
  offline replay and live scoring can't diverge).
- **Temporal evidence fields** — `lib/data/evidence.ts` `EvidenceRecord` already carries
  `observed_at` / `effective_at` / `retrieved_at`. These are the columns the sealed accessor
  filters on.

### The leak surfaces this harness must close

1. **`providerCachedFetch` is keyed to `today`** — `lib/data/provider-fetch.ts` writes/reads
   `av_cache` by `cache_key + cache_date` where `cache_date = new Date()...slice(0,10)`.
   Live scoring always pulls "latest." A replay that called it would get *today's* data
   stamped onto a 2022 as-of date. **The harness must never call the live fetch path.**
2. **`fetchOverview()` returns current TTM fundamentals** — `lib/data/provider-interface.ts`
   AV/FMP overview endpoints return *trailing-twelve-month as-of-now* ratios with no report
   period. Replaying these against a past date silently injects future earnings. This is the
   single most dangerous leak (fundamentals are the slowest-moving, highest-hindsight input).
3. **Universe is static & survivorship-biased** — `lib/edges/universe.ts` says so in its own
   header: current-liquid names only, "chosen with hindsight." SNDK (SanDisk) and delisted
   names are absent; GME's meme-era liquidity profile is not reconstructable from a today
   list. Frozen packets must carry their own point-in-time universe membership + tradability.

---

## 4. Harness architecture

Three components, each a thin layer over existing code.

```
                    ┌─────────────────────────────────────────────┐
                    │  A. Packet Assembler (offline, one-time)     │
                    │  per (symbol, as-of date):                   │
                    │   • prices ≤ as-of      (AV/FD historical)   │
                    │   • fundamentals AS-OF  (report_period ≤ d)  │
                    │   • news ≤ as-of        (published ≤ d)      │
                    │   • universe/tradability flags as of d       │
                    │  → freeze to replay_packet_items + manifest  │
                    └───────────────────┬─────────────────────────┘
                                        │ frozen, hashed, immutable
                    ┌───────────────────▼─────────────────────────┐
                    │  B. Sealed Replay Cursor                     │
                    │   • SealedDataAccessor(asOf)                 │
                    │   • rejects ANY item dated > asOf (throws)   │
                    │   • feeds computeWeightedAnalystScore +      │
                    │     calibration fit/predict + IC classify    │
                    │   • steps as-of forward one trading day      │
                    └───────────────────┬─────────────────────────┘
                                        │ per-date gate verdicts
                    ┌───────────────────▼─────────────────────────┐
                    │  C. Eligibility Reporter                     │
                    │   • first as-of date each gate flips to pass │
                    │   • or "never eligible in window"            │
                    │   • forward return AFTER that date, reported │
                    │     as consequence, never as selection input │
                    └─────────────────────────────────────────────┘
```

### A. Packet assembler — how a "frozen packet" is built

A **packet** = one symbol × one as-of date × the full set of scoring inputs, each stamped
with the date it was knowable. A **cohort** = the MU/INTC/SNDK/GME set of symbols. A
**run** = a cohort replayed across a contiguous sequence of as-of dates.

Freezing rules per input type:

- **Prices (OHLCV):** use provider historical endpoints that accept an explicit end date
  (AV `TIME_SERIES_DAILY` full, FinancialDatasets `get_stock_prices` with date range,
  Yahoo/Kite for India). Keep only candles with `date ≤ asOf`. Prices are the *easy* input —
  they're already dated per row and `computeEdgeIC` already slices them this way.
- **Fundamentals:** this is the hard one and the reason the harness exists. Do **not** use
  `fetchOverview()`. Use period-stamped statements: FinancialDatasets `get_financial_metrics`
  / `get_income_statement` etc. carry a `report_period` **and** an SEC filing/accepted date.
  Freeze the *most recent statement whose filing/acceptance date ≤ asOf* — not whose fiscal
  period ≤ asOf (a Q4 result for period ending Dec 31 is not public until the ~Feb filing).
  If a provider only gives fiscal period and not filing date, add a conservative publication
  lag (e.g. period_end + 45–75 days) and **record that assumption in the packet manifest** so
  the honesty of the freeze is auditable.
- **News / sentiment:** keep only items with `publishedAt ≤ asOf` (FinancialDatasets/AV news
  carry timestamps). Sentiment aggregates recomputed from the filtered set only.
- **Universe / tradability:** each packet carries an explicit `tradable`, `adv`, `price`,
  `market_cap`, `spread_ok` snapshot as of the date — so the eligible-universe floors from
  Phase 2 of the fix prompt can be replayed without leaking today's liquidity.

Assembly is **one-time and offline.** Once a packet is written and hashed it is immutable.
Re-running a replay reads frozen packets; it never re-fetches. This also means the same run
is byte-for-byte reproducible (a manifest hash proves the inputs didn't move) — matching the
`dataset_hash` discipline already in `fitAndStoreCalibration`.

### B. Sealed replay cursor — the leak-prevention mechanism

The core safety primitive is a **`SealedDataAccessor`** bound to a single `asOf` cursor.
Every read of a packet item goes through it, and it **throws** (does not filter silently) if
asked for, or handed, any record whose knowable-date is after `asOf`:

- Construction: `new SealedDataAccessor(asOf, packetItems)`.
- It pre-partitions items and, on any accessor call, asserts `item.knowable_at ≤ asOf` for
  every item it returns. A single violation raises `FutureDataLeakError` and aborts the run.
- It refuses to reach the network at all — it has no provider client. The only way to get
  data into it is a pre-frozen packet. This structurally forecloses leak surface #1 (the
  `today`-keyed live cache) because the live fetch path is simply not reachable from replay.
- The scoring/calibration functions are called with the accessor's outputs, not raw providers.
  `computeWeightedAnalystScore` and `predictPWin` are already pure over their inputs, so no
  change to them is needed — only the *source* of their inputs changes.

Why throw instead of filter: filtering hides bugs. If packet assembly ever mis-stamps a
record, a silent filter would drop it and the run would "look fine." A throw turns a latent
leak into a loud, testable failure — which is exactly what test 14 asserts and what the fix
prompt's "fail loudly" doctrine demands.

The cursor steps forward one trading day at a time across the run window. At each step it
re-seals to the new `asOf` and re-runs the gates. Walk-forward calibration inside a step
still uses `walkForwardFolds()` with its existing purge/embargo — so there are **two** layers
of time-safety: the outer sealed cursor (no packet item after asOf enters the step at all)
and the inner purge/embargo (no train label window bleeds into a test fold).

### C. Eligibility reporter — the honest output

For each (cohort-symbol or cohort, model, setup, horizon), the reporter walks the per-date
verdicts in ascending date order and records the **first** date the gate passes:

```
symbol  model                    setup      horizon  first_eligible_asof  gate_margin  n_oos  ece
MU      quality_catalyst_moment  breakout   10d      2023-01-19           +0.031       41     0.074
MU      turnaround_inflection    inflection 20d      2022-11-08           +0.012       36     0.088
INTC    turnaround_inflection    inflection 20d      never (window ends 2024-06-30)   —       —
SNDK    (delisted 2016; excluded — see §8 open question)
GME     fast_breakdown_defense   crowding   5d       2021-01-27 (VETO fired, not entry)
```

- `first_eligible_asof` is **selected by the gate**, not by a human. There is no
  "pick the date MU doubled" input anywhere in the pipeline.
- Forward return is reported **only as a consequence column, computed strictly after
  `first_eligible_asof`**, and is never fed back into selection, sizing, or gate thresholds
  within the run. It answers "and then what happened?" — it does not choose the date.
- "never eligible in window" is a first-class, honest result. A model that never clears its
  gate on MU across the whole replay window reports `never`, not a fudged partial pass.

---

## 5. Proposed storage schema (describe only — DO NOT create)

Four additive tables. Names/shapes are a proposal; the migration is out of scope for this
draft and must not be applied without approval (and, per the global schema rule, verified
against the target DB before any dependent code ships).

- **`replay_packets`** — one row per (symbol, as-of date). Columns (proposed):
  `id`, `cohort` (text, e.g. `semis_memory_2022`), `symbol`, `market`, `as_of` (date),
  `manifest_hash` (sha256 over the frozen item set), `publication_lag_assumptions` (jsonb),
  `created_at`. Immutable after write.
- **`replay_packet_items`** — the frozen inputs. `id`, `packet_id` (fk), `item_type`
  (`ohlcv`|`fundamental`|`news`|`universe`), `knowable_at` (timestamptz — the date this
  record was public), `source`, `source_tier`, `payload` (jsonb), `payload_hash`. The
  `knowable_at ≤ packet.as_of` invariant is what the sealed accessor enforces at read time
  and what a DB check/backfill test asserts at write time.
- **`replay_eligibility_runs`** — one row per replay execution. `id`, `cohort`, `model_kind`,
  `setup`, `horizon_days`, `window_start`, `window_end`, `packet_manifest_hash` (proves which
  frozen inputs were used), `code_git_sha`, `created_at`.
- **`replay_eligibility_events`** — per (run, symbol, as-of) gate verdict. `run_id`, `symbol`,
  `as_of`, `gate` (`calibration_oos`|`validation`|`ic`|`thin_evidence`|`breakdown_veto`),
  `passed` (bool), `margin` (numeric), `n_oos`, `ece`, `detail` (jsonb). The reporter's
  "first_eligible_asof" is a `MIN(as_of) WHERE passed` query over this table.

Reuse existing tables where possible: labels/returns can still live in
`observation_labels`, and the accessor can read `evidence_records` filtered by
`effective_at ≤ as_of` for any inputs already captured there, rather than duplicating them
into packets.

---

## 6. How it plugs into the existing walk-forward code

- The harness **imports** `walkForwardFolds` and `loadLabeledDataset` from
  `lib/learning/dataset.ts` unchanged — but feeds them observations assembled from sealed
  packets rather than the live `decision_observations` join.
- It **imports** `fitCoefficients` / `predictPWin` / `acceptCalibrationOOS` from
  `lib/validation/calibration.ts` unchanged. The eligibility verdict per as-of date is
  literally `acceptCalibrationOOS(...).accepted` computed on the packet-sealed folds.
- It **imports** `computeWeightedAnalystScore` from `lib/scoring/weighted-score.ts` so the
  replay's analyst_score is identical to production's.
- The only *new* code is: (a) the packet assembler, (b) `SealedDataAccessor` +
  `FutureDataLeakError`, (c) the reporter, (d) the cohort fixtures. The gates themselves are
  reused verbatim — this is what makes the report trustworthy (it tests the real gates, not a
  reimplementation, satisfying the fix prompt's "call the actual services, not duplicate pure
  logic" rule).

---

## 7. Phased build plan & effort

| Phase | Deliverable | Effort (ideal-dev-days) |
|---|---|---|
| **P0 — sealed accessor + leak test** | `SealedDataAccessor`, `FutureDataLeakError`, and a unit test proving a deliberately future-stamped item throws (this alone satisfies test 14's spirit). Pure, no network, no DB. | 1.0 |
| **P1 — packet assembler (prices + news)** | Offline builder for OHLCV and news packets from historical provider endpoints; manifest hashing; immutability. Prices/news are date-stamped so this is mostly plumbing. | 1.5 |
| **P2 — fundamentals as-of** | Filing-date-based fundamental freezing incl. the publication-lag assumption + manifest recording. The hard, high-value phase. | 2.0 |
| **P3 — replay cursor + reporter** | Step-forward cursor wiring the sealed accessor into the reused gates; `replay_eligibility_events` writes; first-eligible query + report table/JSON. | 2.0 |
| **P4 — cohort fixtures + test 15** | MU/INTC/GME (and SNDK caveat) fixtures; the actual `tests/replay-eligibility.test.ts` asserting each model's first-eligible date is gate-selected and no future data is touched. | 1.0 |
| **P5 — schema migration (gated)** | The four tables, additive, applied only after owner approval + target-DB verification per the global schema rule. | 0.5 |
| | **Total** | **~8 dev-days** |

P0 is independently valuable and low-risk — it can land and satisfy the test-14 guard before
the heavier packet work. Recommend building P0→P4 as offline/measure-only (no money path
touched, consistent with the fix prompt's "shadow/measure-only first" doctrine); P5 last.

---

## 8. Risks / open questions

1. **Fundamental publication dates.** The whole honesty of the fundamentals freeze rests on
   knowing the *filing/acceptance* date, not the fiscal period. If the chosen provider only
   exposes fiscal period, the publication-lag heuristic is an assumption that must be visible
   in every report. Open question: does FinancialDatasets `get_filings`/`get_income_statement`
   reliably return an accepted/filed date for the 2020–2023 window for these symbols? Needs a
   spike before P2.
2. **SNDK (SanDisk) was delisted (acquired by Western Digital, 2016).** Historical data for a
   delisted ticker is spotty and the current providers/universe don't carry it. Options:
   (a) drop SNDK and document why, (b) source a one-off frozen CSV for it, (c) substitute a
   still-listed memory/NAND name (WDC/MU) and note the substitution. **Owner decision needed.**
   The requirement says "SNDK-*style*", so a documented substitution is likely acceptable.
3. **GME is an exit/veto case, not an entry case.** The honest expected result for GME is that
   the fast-breakdown/crowding defense (fix prompt Phase 2 §4) fires a **veto**, not that an
   entry model becomes "eligible." The reporter must represent veto-fired distinctly from
   entry-eligible so GME isn't scored as a missed long.
4. **Small-n calibration on a 4-symbol cohort.** `acceptCalibrationOOS` needs ≥30 OOS rows.
   A single symbol across a replay window won't reach that from its own observations. The
   cohort/universe must be broad enough at each as-of date to produce a real holdout — i.e.
   the replay universe is the *point-in-time liquid set*, and the named symbols are the ones
   we *report* on, not the entire training set. This must be designed in from P3.
5. **Corporate actions (splits/dividends) inside the window.** Frozen prices must be
   split-adjusted *as known at each as-of date*, which is subtle (a split that happens after
   asOf must not be retro-applied to pre-asOf candles). Needs explicit handling in P1.
6. **Cost/rate limits of historical backfill.** Assembling multi-year daily packets for a
   cohort burns provider budget (`provider-fetch.ts` daily caps). Assembly should be a
   throttled, resumable one-time job, not a cron.

---

## 9. What this harness does NOT do

- **It is not a backtester and does not simulate P&L, fills, slippage, or position sizing.**
  It answers one question: *when would each model have become eligible?* Realized-return
  backtesting is the Validation Engine's job (`lib/validators/backtest.ts`); this harness only
  reports the forward return *after* the eligibility date as a read-only consequence.
- **It does not touch the money path.** No orders, no `strategy_config`, no live/paper
  execution, no autonomous flags. Consistent with the fix prompt: measure/shadow only.
- **It does not promote or demote any model.** Eligibility here is a historical diagnostic,
  not a live promotion signal. Promotion stays governed by the existing Validation Engine +
  owner review (`docs/arch/09-learning-loop.md`).
- **It does not fix survivorship bias in the live universe** (`lib/edges/universe.ts`). It
  works around it *for the replay* by carrying per-packet universe membership, but building a
  true versioned PIT index membership (fix prompt Phase 2 §2) is a separate effort.
- **It does not hand-pick outcome dates** — by construction. The absence of any "future return
  date" input is the feature, and P0's leak test is what proves it.
- **It does not re-fetch on replay.** Once packets are frozen, a run is a pure function of
  frozen inputs + gate code, reproducible via the manifest hash.

---

## 10. Docs to update when this ships (per CLAUDE.md)

- `docs/arch/09-learning-loop.md` — new "Historical Replay Harness" section under Validation.
- `docs/arch/04-database-schema.md` — the four `replay_*` tables (only after migration applied
  and verified).
- `public/agent-diagrams/system-map.json` — only if the harness becomes a scheduled/agent flow
  (currently proposed as an offline tool, so likely no system-map change).
- This file: flip STATUS to approved and record the approval date.
