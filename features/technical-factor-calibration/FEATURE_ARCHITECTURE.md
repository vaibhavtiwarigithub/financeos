# Technical Factor Calibration

> Status: **APPROVED FOR MEASURE-ONLY IMPLEMENTATION**
> Approved by owner: 2026-07-21
> Decision authority: `PROJECT_DECISIONS.md` Decision 51

## 1. Decision

Measure whether Kairos's existing technical score and a deliberately small set of
candidate technical factors predict forward returns in the existing Edge evidence
lab. Do not change production scoring from this feature.

The first trial family is frozen to:

1. `kairos_technical_score_v1`: the exact current `computeTechnicals` plus
   `scoreTechnicals` composite, including its breakdown veto;
2. `rel_strength_6m`: the existing stock-minus-market six-month return;
3. `macd_atr_12_26_9`: MACD(12,26,9) histogram divided by Wilder ATR(14);
4. `signed_adx_14`: ADX(14) strength signed by +DI versus -DI; and
5. the existing price/volume factors already in EdgeScout.

No Fibonacci, oscillator zoo, per-stock optimization, or automatic sector formula
is added. MACD and ADX are challengers, not new score weights.

## 2. Why

The current technical formula is a hand-tuned prior. Kairos needs a repeatable way
to determine whether the composite, its existing components, or a small challenger
set adds market-local forward-return information. The same path must be reusable
when parameters are reconsidered later and must retain losing trials to prevent
selection-history erasure.

## 3. Existing Substrate

Reuse the existing measure-only Edge lab:

- `lib/edges/registry.ts`: pure factor definitions over candles frozen at `asOf`;
- `lib/edges/ic.ts`: market-local forward-return rank IC with sampled dates and
  Newey-West standard errors;
- `edge_signals` and `edge_signal_inputs`: immutable prospective observations and
  input lineage;
- `edge_ic_history`: historical diagnostics; and
- `edge_market_status`: advisory market-level lifecycle only.

This feature creates no parallel truth layer and makes no provider call per added
factor. EdgeScout resolves a symbol's candle history once and evaluates every factor
over that same snapshot.

## 4. Recalibration And Memory

An edge ID is a versioned formula identity. Changing any period, threshold, anchor,
normalization, unavailable-data rule, or veto creates a new edge ID; it never edits
an old ID in place. Every run records market, horizon, window end, segment, history
depth, sampling step, universe size, evidence quality, and provider report.

`edge_ic_history` stores separate rows for:

- `segment_type = market`, `segment_value = all`; and
- `segment_type = sector`, `segment_value = <normalized sector>`.

Old market-wide rows are migrated to the explicit `market/all` identity. A rerun of
the same edge/market/window/horizon/segment against the exact same frozen dataset and
configuration is idempotent. Provider corrections or newly available symbols change
the dataset fingerprint and append a distinct snapshot. Each report records the
benchmark source and per-provider symbol counts so the change is explainable. A changed
formula requires a new edge ID and therefore appends a distinct trial history.

The Vibe comparator is pinned separately to commit
`a5eb30fd00d6ee71cd5099d15f57de5ae47010ff`. Its full package is not admitted:
the audited package includes LLM, MCP, broker, web, dynamic-import, and network
dependencies unnecessary for calibration. A later sandbox may compare a narrowly
vendored MIT validation subset against the same frozen inputs. It cannot replace
Kairos evidence or influence scoring.

## 5. Sector Policy

Sector is an evaluation slice, not initially a separate strategy:

- use `symbol_profiles.sector` when present;
- fall back only to Kairos's deterministic known-symbol map;
- treat missing, `Other`, diversified funds, fixed income, commodities, and digital
  assets as unclassified and exclude them from equity-sector conclusions;
- require at least five symbols in a sector on an as-of date before calculating its
  cross-sectional IC; and
- require the existing minimum of 36 independent sampled IC observations before a
  sector result can be anything other than `measure_only`.

Sector-specific parameters require a separate future decision. They must improve
out of sample across multiple windows and neighboring parameter values after all
tested sectors/parameters are included in the trial family. A single strong sector
backtest is not sufficient.

## 6. Market Isolation

US and India are evaluated independently. They never share symbols, benchmarks,
returns, sectors, observations, IC rows, status, currency, or promotion evidence.
The same formula may be useful in one market and benched in the other.

## 7. Safety Boundary

This feature may write only Edge analytics, run metadata, and System Health state.
It may not read or write production score weights, `agent_signals`, entry eligibility,
mandates, positions, cash, proposals, broker orders, or exits. No LLM participates.

`shadow_eligible` remains advisory. No result changes production behavior without a
separate architecture, locked holdout, trial-family correction, shadow observation,
paper validation, and owner approval.

## 8. Acceptance Criteria

- Existing production `scoreTechnicals()` is represented exactly as a versioned edge.
- MACD is normalized by ATR and returns null on insufficient/invalid data.
- ADX uses Wilder smoothing, is direction-signed, and returns null on insufficient data.
- Market-wide and sector rows cannot collide in persistence.
- Sector rows never change `edge_market_status`; only market/all evidence can do so.
- Unknown/thin sectors abstain rather than report zero or fabricate confidence.
- Added factors trigger no additional provider request within a run.
- Formula, as-of slicing, market isolation, segment isolation, and thin-sample tests pass.
- Every persisted report names the benchmark source and per-provider symbol counts.
- TypeScript, Vitest, production build, migration verification, and security checks pass.

## 9. Build Order

1. Version and add the three bounded factor definitions.
2. Extend IC evaluation with optional sector maps and explicit segments.
3. Migrate historical IC rows to `market/all` and update the unique key.
4. Load display/profile sector metadata at the measure-only route boundary.
5. Run US and India diagnostics; allow the existing evidence floor to abstain.
6. After enough evidence, compare parameter plateaus and decide whether any native
   score change deserves a separate proposal.

## 10. Explicit Non-Goals

- No score/weight/threshold change.
- No Vibe app, agent, MCP, provider, or broker installation.
- No per-sector production parameters.
- No automatic selection of the best in-sample trial.
- No claim that retrospective current-universe history is point-in-time or free of
  survivorship bias.
