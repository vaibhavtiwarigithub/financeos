# Ledger map — which table answers which question

Stage 0R step 1 deliverable. Written because an earlier draft of
`FEATURE_ARCHITECTURE.md` pointed at the wrong ledger and concluded the
validation pipeline had never run. It had never run — but not for the reason
given, and not in the table named.

Verified against production 2026-09-01.

| table | written by | question it answers | rows |
|---|---|---|---:|
| `strategy_evaluations` | `lib/evaluation/run-evaluation.ts:121` | **Mandate-level Performance Truth** — how did the WHOLE BOOK do against its mandate? | 0 |
| `validation_experiments` | `lib/validation/engine.ts:140` | **Did a challenger SCORING GENOME beat the champion?** Alternative dimension weights, graded on decision observations. | 0 |
| `backtest_experiments` | Alpha Lab, OOS runner, replay | **Immutable experiment ledger.** Sealed results with fingerprints, trial family, data cutoff, code version. | 18 |
| `strategy_templates` | seed | Reference strategy definitions. | 7 |
| `strategy_sleeves` | seed | Sleeve definitions. | 7 |
| `trial_family_ledger` | `register_trial()` RPC | **How many specifications has this family ever attempted?** The multiple-testing denominator. | 0 (new) |
| `strategy_template_shadow_configs` | — | Predeclared template/combination shadows. | **NOT DEPLOYED** |

## The correction that matters

`strategy_evaluations` and `validation_experiments` are **different subsystems**,
and neither is an external-strategy replay ledger.

- Producing a `strategy_evaluations` row would prove the book-level Performance
  Truth job runs. It would say nothing about strategy validation.
- Producing a `validation_experiments` row would prove the validation ENGINE
  runs — but that engine grades **scoring weights against decision
  observations**. It structurally cannot evaluate an SPY moving average, an
  RSI(2) rule, NR7, or a monthly rotation. Those are price rules over bars, not
  weightings over scored observations.

**Therefore neither table is the target for external-strategy work.** The correct
destination is `backtest_experiments`, which already works (18 rows: 13 alpha
diagnostic, 3 OOS IC, 2 historical replay) and already carries the provenance a
sealed replay needs: `trial_family_id`, `trials_considered`, `data_cutoff`,
`code_version`, `plan_fingerprint`, `universe_fingerprint`,
`dataset_fingerprint`, `run_fingerprint`.

## What was missing, and is now built

The gap was never a ledger. It was the **seam** between a rule and a sealed
result:

| piece | status |
|---|---|
| frozen rule spec + fingerprint | `lib/strategy-replay/rule-spec.ts` |
| rule -> simulator events | `lib/strategy-replay/compile.ts` |
| **deterministic NAV / benchmark marker** | `lib/strategy-replay/nav-marker.ts` |
| negative controls | `lib/strategy-replay/negative-control.ts` |
| immutable trial counting | `trial_family_ledger` + `register_trial()` |

The NAV marker is the piece the architecture wrongly assumed existed.
`lib/simulation/portfolio-simulator.ts` returns `endingCash`, `positions`,
`fills`, `rejections`, `realizedPnl` — **no daily NAV path**, so Sharpe, Sortino,
drawdown, benchmark alpha and stress-day correlation were all uncomputable from
it. Alpha Lab A6 had solved this privately inside
`lib/analytics/alpha-diagnostics-portfolio.ts`; the new module is the shared,
spec-agnostic version, so replay does not become a second implementation.

## Still not deployed, deliberately

`strategy_template_shadow_configs` — the migration is committed and **revised**
per review (fingerprint now covers operator, weights, rule version and trial
family; immutable-config trigger; append-only lifecycle event ledger with reason,
evidence snapshot and actor). It stays unapplied until the feature that needs it
is approved. `to_regclass` returns NULL in production.
