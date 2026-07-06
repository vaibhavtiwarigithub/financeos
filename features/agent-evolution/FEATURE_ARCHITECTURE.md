# Feature Architecture: Agent Evolution (source-attributed discovery, expanded genome, US/India parity)

## Status

Architecture status: Draft
Architecture approved: No
Approved scope: None
Approved date: None
Implementation allowed: No

Prompted by a second Codex adversarial review pass (2026-07-06), specifically
scoped to whether ResearchAgent's parameters, discovery sources, and
LearnerAgent's evolution surface are actually appropriate for a world-class
long-only swing-trading agent across US and India — as opposed to whether the
current code has bugs (that pass is Decision 43, already fixed).

## Feature Purpose

Three related gaps, all downstream of the same root cause — the system has no
memory of *which discovery source* or *which parameter* a decision came from,
so it can't learn which sources/parameters are worth trusting:

1. **Symbol discovery is unattributed.** `gatherSymbols()` in
   `lib/research-agent.ts` merges 7 sources (holdings, watchlist, Theme Scout,
   momentum bucket, value bucket, metals basket, region ETFs, India NIFTY) into
   one flat list. Once merged, a `decision_observations` row only knows
   `source: "holding" | "screener"` — Theme Scout picks, momentum-bucket picks,
   and value-bucket picks all collapse into the same `"screener"` label. There
   is no way to ask "did Theme Scout's picks actually make money over the last
   90 days?" without hand-joining `watchlist.theme`/`features.screener.bucket`
   against `observation_labels` — a query nobody runs today.
2. **LearnerAgent only evolves 5 numbers.** `update_signal_weight` (Decision
   43 hardened it, but its scope is unchanged) can only move
   `fundamental_weight` / `technical_weight` / `sentiment_weight` /
   `macro_weight` / `insider_weight`. Everything else that defines the
   strategy — score threshold, position sizing curve, stop/target logic,
   which discovery sources get research budget, India-specific gates — is
   either a fixed constant in code or a value the user sets by hand in
   Settings. The "evolution" the product promises is five numbers wide.
3. **India is US scoring wearing a currency label.** `isIndia(symbol)` swaps
   Alpha Vantage for Yahoo and skips social/options/insider (honest), but
   reuses the exact same `score_threshold`, RSI/EMA thresholds
   (`lib/data/technicals.ts`), and benchmark logic path as the US. There is no
   India-specific liquidity filter, no NSE holiday-aware freshness check on
   candle data, and India's `computeRegimeFeatures` benchmark is `^NSEI` only
   because someone hardcoded it in — not because it went through the same
   validation gate a US weight change does.

## User/System Questions This Feature Answers

- Which discovery source (Theme Scout, momentum, value, watchlist, held,
  India NIFTY, metals, region ETF) actually produces profitable signals, and
  should the system research more/fewer symbols from it?
- If LearnerAgent wants to change something other than the 5 score weights
  (e.g. "raise the score threshold" or "shorten the holding horizon"), is
  there a governed, validated path to do that, or does it require a manual
  code change?
- Is India's scoring gated on India-appropriate evidence, or silently reusing
  US assumptions that were never checked against India data?

## Scope

This feature includes:
- A primary `discovery_source` field recorded on every new
  `decision_observations` row (`held_position | manual_watchlist |
  theme_scout | momentum_bucket | value_bucket | india_nifty |
  india_screen_cache | metals | region_etf | unknown_legacy`) plus
  `discovery_sources_all`/`discovery_metadata` for multi-source provenance.
  This is additive. It does **not** remove or reinterpret the current
  `agent_signals.source: "holding" | "screener"` field in v1, because that
  field is already used by existing UI/reporting paths.
- A read-only **Discovery Source Scorecard** (API + dashboard card) showing,
  per source: candidates researched, entry-eligible rate, and — once
  `observation_labels` mature — mean `benchmark_neutral_return`. Advisory
  only in v1; see Non-Goals.
- An extended **strategy genome schema** (`strategy_versions.genome`, already
  typed per Phase 3 — see `lib/validation/genome.ts`) covering the fields
  listed under "Proposed genome fields" below, each with an explicit bounded
  range and a validation-gate requirement before promotion — no new field
  becomes live without going through the exact same challenger → validate →
  promote path `update_signal_weight` already uses.
- An **India evidence contract**: a documented, code-enforced minimum
  (candle freshness vs NSE trading calendar, minimum liquidity proxy, minimum
  fundamental-field count) that must hold before a India candidate is
  eligible to enter `long`, independent of and stricter than the general
  thin-evidence abstain rule from Decision 43.
- A written decision on whether India gets its own `score_threshold`/RSI
  bands or continues sharing the US ones, backed by whatever India-labeled
  ledger data exists at the time (may conclude "not enough India data yet to
  diverge — keep shared, revisit after N India closed trades").

## Non-Goals

This feature does not include:
- **Any automatic reallocation of research budget by source.** The Discovery
  Source Scorecard is read-only/advisory in v1. Automatically researching
  more Theme Scout candidates because they scored well recently is a
  feedback loop that needs its own validation story (a source that looks
  good on 20 trades can regress) — out of scope until the scorecard has run
  long enough to have an opinion on its own reliability.
- **Auto-promotion of any genome field.** Every genome-field change flows
  through the existing challenger/validate/promote lifecycle. Nothing here
  makes a strategy_versions row live without a human promoting it via the
  Strategy Registry, same as today.
- **Increasing screener candidates above 3/day.** CLAUDE.md locks this at 3;
  this feature does not touch that number regardless of what the Discovery
  Source Scorecard shows.
- **Explicit bull/bear regime switching.** CLAUDE.md explicitly wants scoring
  to adapt via weights, not a hardcoded regime branch. Nothing in the genome
  expansion below introduces an if/else on regime; `regime` stays an
  observed feature (`features.regime.*`, Phase 3) available to future
  weight/threshold learning, not a switch.
- **Loosening trade approval.** No genome field, however it evolves,
  changes `approval_required` gating on `TraderAgent`/live orders. Paper
  trading and shadow evaluation remain the only channels a genome change can
  reach before a human promotes it.
- **Building India-specific thresholds speculatively.** This feature defines
  the *contract* (what evidence India needs) and instruments the ledger to
  measure whether shared vs India-specific thresholds perform differently.
  It does not invent India-specific RSI/threshold numbers without validated
  India trade history to back them — CLAUDE.md's "don't run ahead of
  evidence" principle applies here as much as to weight changes.

## Codex Review Amendments Required Before Build

These amendments close ambiguity in the draft architecture and should be
treated as part of the target design:

1. **Do not collapse multi-source provenance into one lossy label.** A symbol
   can be a held position, a manual watchlist item, a Theme Scout candidate,
   and a screener hit on the same day. Persist one primary
   `discovery_source` for grouping, but also persist `discovery_sources_all`
   and `discovery_metadata` so source performance can be audited without
   losing assisted-source credit.
2. **Keep legacy `agent_signals.source` stable.** The new source fields belong
   on the decision/research ledger. Do not rename or overload
   `agent_signals.source` in this PR; existing UI expects the coarse
   `holding | screener` meaning.
3. **Scorecard must be statistically honest.** It must show sample size,
   label coverage, benchmark-relative win rate, confidence interval, and
   insufficient-sample status. A raw average return by source is too easy to
   overread and will invite bad allocation decisions.
4. **No source-budget feedback loop in v1.** Source performance can be shown to
   the user, but cannot change `gatherSymbols()` allocation until a separate
   exploration policy exists with a minimum exploration floor and shadow
   validation.
5. **Separate provisioned genome fields from live-consumed fields.**
   `score_threshold` may be added to the genome schema and validation engine
   in this PR, but ResearchAgent must continue using the current approved
   runtime threshold path until a later approved promotion/consumption change
   defines precedence against `strategy_config`.
6. **India gates must fail closed for entry eligibility.** If the NSE calendar,
   candle freshness, liquidity proxy, or required fundamentals are unknown,
   the system may still record an observation, but it must not mark the India
   candidate entry-eligible.

## Current Behavior

- `gatherSymbols()` returns a flat `SymbolEntry[]` with only `isHeld`,
  `isEtf`, `assetClass`, and an optional `screenerBucket` (momentum/value —
  added Decision 41, screener-only). Theme Scout candidates arrive via the
  `watchlist` table read and are indistinguishable from a manually-added
  watchlist symbol once merged.
- `processSymbol()` sets `source: isHeld ? "holding" : "screener"` on
  `agent_signals`, and copies the same 2-value `source` onto
  `decision_observations` implicitly via the `market`/symbol join — there is
  no persisted "this candidate came from Theme Scout" flag past the
  `features.screener` block (which only exists for the momentum/value
  screener bucket, not Theme Scout/watchlist/held/metals/region-ETF/India).
- `update_signal_weight` (LearnerAgent) is the only live weight-mutation
  tool. `strategy_versions.genome` exists (Phase 3, migration 063) and is
  validated (`lib/validation/genome.ts`) but nothing currently proposes
  genome mutations beyond the 5 weights — the genome column is provisioned
  infrastructure, not yet a used surface.
- India shares `score_threshold`, `stop_loss_pct`, `target_pct` from the same
  `strategy_config` row as US (no `market`-scoped strategy_config columns
  exist yet — only `strategy_versions` is market-scoped, per Phase 4).
  India's NSE holiday gate (Decision 39) only covers 2 fixed-date holidays
  (Republic Day, Independence Day, Gandhi Jayanti) — floating festivals
  (Holi, Diwali) are explicitly unmodeled, a known, documented gap.

## Proposed Behavior

### 1. Discovery source attribution

- Extend `SymbolEntry` (`lib/research-agent.ts`) with a required
  `discoverySource` field, set at the point each source contributes a symbol
  in `gatherSymbols()`: `held_position`, `manual_watchlist` (manual, non-theme),
  `theme_scout` (watchlist rows with `source: 'llm_theme'`), `momentum_bucket`
  / `value_bucket` (already tagged via `screenerBucket`, just renamed into
  the same enum), `metals`, `region_etf`, `india_nifty`, and
  `india_screen_cache` if the broader India scanner cache is later wired into
  ResearchAgent.
- Extend `SymbolEntry` with `discoverySourcesAll` and optional
  `discoveryMetadata`. When a symbol appears from multiple sources in one run,
  keep all sources. Pick the primary source by causal priority:
  `held_position` > `manual_watchlist` > `theme_scout` > `momentum_bucket` /
  `value_bucket` > `india_screen_cache` > `india_nifty` > `metals` >
  `region_etf`. The scorecard should support both primary-source metrics and
  assisted-source metrics once enough data exists.
- Persist `discovery_source` on `decision_observations` (new column,
  migration) alongside the existing `features.screener` block — additive,
  does not replace the momentum/value bucket detail already recorded.
- Persist `discovery_sources_all` and `discovery_metadata` next to
  `discovery_source`. `discovery_sources_all` is required for new observations
  and should include the primary source; `discovery_metadata` may include
  contributing watchlist row IDs, screener bucket/rank, theme name, or scanner
  run ID when available.
- New read-only endpoint `/api/agents/discovery-scorecard`: per
  `discovery_source` × market, count of candidates researched (last 90d),
  entry-eligible rate, and mean `benchmark_neutral_return` where matured
  labels exist (reuses `lib/learning/dataset.ts`'s join, grouped by source
  instead of by fold). Surfaced as a card on the Research Journal's Evolution
  tab — extends existing UI, no new page.

- The scorecard must report source/market/horizon rows across at least 30d and
  90d windows, including `nResearched`, `nLabeled`, `labelCoveragePct`,
  `entryEligibleRate`, `abstainRate`, `avgDataAvailability`,
  `meanBenchmarkNeutralReturn`, `medianBenchmarkNeutralReturn`,
  `winRateVsBenchmark`, `bootstrapCiLow`, `bootstrapCiHigh`, and
  `sampleStatus`. If a row lacks enough matured labels, show
  `sampleStatus: "insufficient_data"` instead of a performance verdict.

### 2. Genome expansion (validated, shadow-first)

Proposed additional genome fields (each independently bounded, independently
gated by the SAME validation path — walk-forward replay via
`lib/validation/engine.ts`'s shared `computeWeightedAnalystScore`, extended
per field type below):

| Field | Bounds | Validation approach |
|---|---|---|
| `score_threshold` | 50–75 | Replay: what would entry-eligible rate + benchmark-neutral return have been at this threshold, using labeled history — same walk-forward/bootstrap machinery as weights. |
| `holding_horizon_days` | 2–20 | Already have 2/5/10/20-day labels (`observation_labels`); replay picks the horizon whose labeled return the strategy is actually evaluated against. |
| `stop_loss_pct` / `target_pct` | bounded % | Already partially dynamic via MAE/MFE percentiles (`lib/risk/percentiles.ts`); genome field would let a challenger propose a *different percentile* (e.g. p20/p80 instead of p25/p75), validated the same way. |
| `discovery_source_weights` | 0–1 per source, sum-normalized | Read-only in v1 (see Non-Goals) — recorded in genome as a *proposed* field once the Discovery Source Scorecard has enough history to inform it, not wired to actually change `gatherSymbols()`'s candidate mix until a future, separately-approved iteration. |
| `sizing_curve_params` | half-Kelly cap, floor | Currently hardcoded in `lib/risk/sizing.ts` defaults; genome field would let a challenger propose different cap/floor, validated against the ledger's realized Kelly-implied returns. |

None of these are proposed as an immediate LearnerAgent tool. This document
recommends building ONE new field (`score_threshold` — cheapest to validate,
reuses 100% of existing walk-forward machinery, most directly answerable
question: "is 60 the right bar?") end-to-end as a proof of the pattern before
expanding to the rest, rather than shipping all five/six new tunable fields
in one PR. Each subsequent field follows once `score_threshold` has round-
tripped through challenger → validate → promote at least once, on real data.

Important runtime boundary: this PR may provision and validate
`genome.entry.score_threshold`, but it must not silently make ResearchAgent
consume that field. Runtime threshold precedence must be approved separately
because today `strategy_config.score_threshold` acts as a user-visible manual
control. Until that follow-up is approved, the genome threshold is a shadow
candidate parameter only.

### 3. India evidence contract

Documented (and code-enforced in `lib/data/scores.ts`/`lib/india-data.ts`)
minimum evidence before an India candidate is `entry_eligible`:
- Candle data freshness checked against an NSE trading-calendar-aware
  cutoff, not a flat day count (extends Decision 39's fixed-holiday gate to
  also flag stale-but-not-holiday data, e.g. Yahoo feed lag).
- Minimum liquidity proxy (e.g. average daily traded value over N days,
  sourced from Yahoo's `averageVolume`/`price.regularMarketVolume` — needs a
  concrete threshold, to be set from observed India ledger data once ~60
  India observations exist, not guessed today).
- The `hasMinFundamentalFields` gate from Decision 43 already applies to
  India; this section formalizes it as a *documented* India-specific
  contract rather than an incidental side effect of a US-shaped check.
- Fail-closed rule: if NSE calendar freshness, latest candle freshness,
  liquidity proxy, or required fundamentals cannot be determined, the system
  may still save the observation with an explicit reason code, but it must
  set `entry_eligible = false` for that India candidate.
- ResearchAgent v1 currently uses the static NIFTY candidate path; the broader
  India scanner/cache path should not be assumed live for ResearchAgent unless
  wired explicitly. If that cache is later used as a source, tag it as
  `india_screen_cache` rather than mixing it into `india_nifty`.
- Explicit open question, not resolved by this document: does India get its
  own `score_threshold` once enough India-labeled data exists? Recommendation
  is to instrument (via the Discovery Source Scorecard's `market` dimension,
  already present) and revisit once India has 60+ matured observations
  (the same bar Phase 2 validation already uses for US) — not decide now
  from zero data.

## User Journey / System Flow

1. Research cron runs `gatherSymbols()` → every returned `SymbolEntry` now
   carries a `discoverySource`.
2. `processSymbol()` writes `discovery_source` onto `decision_observations`
   alongside the existing score/availability/weighting fields (Decision 43).
3. Nightly/weekly, the Discovery Source Scorecard endpoint aggregates
   matured observations by source × market — visible on Research Journal.
4. LearnerAgent (future PR, not this one) gains a `propose_genome_field`
   tool scoped initially to `score_threshold` only, mirroring
   `update_signal_weight`'s evidence-binding: server recomputes the replay
   itself, refuses on insufficient data, creates a challenger, never mutates
   live config directly.
5. Validation Engine's existing walk-forward/bootstrap gate (`lib/validation/
   engine.ts`) evaluates the challenger; promotion is manual via Strategy
   Registry, same as weight challengers today.
6. India's evidence contract runs inline in `computeScores`/`processSymbol`
   for every India candidate, independent of and prior to the shared
   thin-evidence abstain check from Decision 43.

## Screen / Page / Module Inventory

- `lib/research-agent.ts` — `SymbolEntry.discoverySource`, `gatherSymbols()`,
  `processSymbol()` (persist `discovery_source`).
- New migration — `decision_observations.discovery_source` column.
- New `app/api/agents/discovery-scorecard/route.ts`.
- `app/dashboard/research-journal/page.tsx` — new "Discovery Sources" card on
  the Evolution tab.
- `lib/validation/genome.ts` — extend bounded-field schema for
  `score_threshold` (first field only, per Proposed Behavior §2).
- `app/api/agents/learner/route.ts` — future `propose_genome_field` tool
  (explicitly deferred to a follow-up PR, not built in this pass).
- `lib/india-data.ts`, `lib/data/scores.ts` — India evidence contract checks.

- `lib/learning/dataset.ts` - include source/provenance fields in the labeled
  observation dataset used by scorecards and later validation.
- Tests for source attribution precedence, legacy unknown-source handling,
  scorecard insufficient-sample behavior, genome threshold bounds, and India
  fail-closed gates.

## System Architecture

### Modules
- Discovery attribution lives entirely in `lib/research-agent.ts` — no new
  service, extends the existing `SymbolEntry`/`processSymbol` types.
- Genome validation reuses `lib/validation/engine.ts` and
  `lib/scoring/weighted-score.ts` (Decision 43) unchanged in mechanism;
  `objectiveTerm`'s per-row scoring already supports whatever weights a
  challenger proposes — extending it to also vary `score_threshold` per
  challenger is a parameter, not a new code path.

### API Contracts
- `GET /api/agents/discovery-scorecard?market=us|india&days=90` → `{
  sources: [{ source, market, n, entryEligibleRate, meanBenchmarkNeutralReturn
  | null }] }`. Read-only, no side effects.

Required scorecard response shape:
`GET /api/agents/discovery-scorecard?market=us|india&days=30|90&horizon=2|5|10|20`
returns `{ sources: [{ source, market, horizonDays, windowDays, nResearched,
nLabeled, labelCoveragePct, entryEligibleRate, abstainRate,
avgDataAvailability, meanBenchmarkNeutralReturn, medianBenchmarkNeutralReturn,
winRateVsBenchmark, bootstrapCiLow, bootstrapCiHigh, sampleStatus }] }`.
Read-only, no side effects. `sampleStatus` must distinguish `sufficient`,
`insufficient_labels`, and `legacy_unknown_source`.

### Data Models
- `decision_observations.discovery_source text` (new, nullable — existing
  rows have no source recorded, must degrade gracefully, not backfilled).
- `strategy_versions.genome` — already jsonb (migration 063); this feature
  adds `score_threshold` as a recognized, bounded key, validated by
  `lib/validation/genome.ts`'s existing bounds-checking pattern.

- `decision_observations.discovery_source` is nullable in DB only for legacy
  rows; new code paths must write one of the approved source values. Use a
  check constraint or shared enum list for: `held_position`,
  `manual_watchlist`, `theme_scout`, `momentum_bucket`, `value_bucket`,
  `india_nifty`, `india_screen_cache`, `metals`, `region_etf`,
  `unknown_legacy`.
- `decision_observations.discovery_sources_all jsonb not null default '[]'`
  records all contributing sources and must include the primary source on new
  writes.
- `decision_observations.discovery_metadata jsonb` records optional provenance:
  watchlist row ID, theme, screener bucket/rank, scanner run ID, and stale/gate
  reason codes.
- Add indexes for scorecard reads: `(market, discovery_source, ts desc)` and,
  if query plans require it, a GIN index on `discovery_sources_all`.

### Error Handling
- Discovery Source Scorecard degrades to "insufficient data" per source
  below some minimum n (mirrors Validation Engine's `nObservations < 60`
  gate) rather than showing a misleading small-sample average.

## Data Architecture

- Required data: `decision_observations.discovery_source` (new),
  `observation_labels` (existing, joined by symbol+market+horizon).
- Optional data: benchmark-neutral return only where labels have matured;
  scorecard rows show `n` researched even before any label matures.
- Mock vs real vs derived: fully derived from real ledger rows, no
  synthetic/seed data.
- Persistence: additive column, fail-soft insert (same pattern as
  `availability_mask`/`weighting` in Decision 43 — a missing column must
  never fail a research run).
- Validation: genome field validation reuses Phase 2's walk-forward +
  block-bootstrap statistical bar unchanged (p_improvement ≥ 0.80, CI floor,
  n_effective ≥ 12, ≥3/5 folds won).

## Files Likely To Change

- `lib/research-agent.ts`
- `supabase/migrations/0NN_decision_observations_discovery_source.sql` (new)
- `app/api/agents/discovery-scorecard/route.ts` (new)
- `app/dashboard/research-journal/page.tsx`
- `lib/validation/genome.ts`
- `lib/india-data.ts`, `lib/data/scores.ts`
- `public/agent-diagrams/system-map.json` — LEARNER/RESEARCH node descriptions
  need updating once genome fields beyond weights exist (CLAUDE.md's
  system-map rule).

## Files / Behavior That Must Not Change

- `TraderAgent`/live order `approval_required` gating — no genome field
  reaches live execution without a human approving the order, same as today.
- Screener candidates/day cap (3) — CLAUDE.md-locked, not touched by
  discovery-source attribution or scorecard.
- No explicit regime branch introduced anywhere in this feature — `regime`
  remains an observed feature, not a switch.
- `update_signal_weight`'s existing evidence-binding (Decision 43) — the
  proposed `propose_genome_field` tool must follow the identical
  fail-closed-on-fallback-data pattern, not a weaker one.

## Acceptance Criteria

- Every new `decision_observations` row has a non-null `discovery_source`
  matching one of the approved source values, and `discovery_sources_all`
  includes the primary source. Legacy rows are surfaced as `unknown_legacy`,
  never silently grouped into a real source.
- Discovery Source Scorecard returns real, non-fabricated aggregates and
  clearly marks sources with insufficient sample size rather than showing a
  misleading number.
- Discovery Source Scorecard exposes label coverage, abstain rate,
  benchmark-relative win rate, median return, and confidence interval, not
  only mean return.
- Source scorecard output does not alter research allocation, candidate count,
  paper trading, or live-trading eligibility in v1.
- `score_threshold` is provisioned in the genome schema and validated by the
  existing walk-forward engine, but is NOT proposable by LearnerAgent until a
  separately-approved follow-up implements `propose_genome_field` end-to-end
  (this PR builds the plumbing/contract, not the LLM-facing tool).
- ResearchAgent does not consume `genome.entry.score_threshold` until a
  separate approved runtime-precedence decision says how it interacts with
  `strategy_config.score_threshold`.
- India evidence contract checks are documented in this file and enforced in
  code; no India-specific `score_threshold` divergence is introduced without
  a documented ledger-backed reason.
- India candidates with unknown calendar/freshness/liquidity/fundamental
  evidence are saved as observations but are not marked entry-eligible.
- Tests cover source attribution precedence, multi-source provenance,
  scorecard insufficient-sample behavior, legacy rows, genome threshold
  bounds, and India fail-closed gates.

## Approval

Architecture approved: No
Approved scope: None
Implementation allowed: No
