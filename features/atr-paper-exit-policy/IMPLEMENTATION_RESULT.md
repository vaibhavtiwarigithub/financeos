# ATR Paper Exit Evidence - Implementation Result

> Completed: 2026-07-22
> Scope: measure-only; no paper, live, broker, or protective-order activation

## Shipped

- Entry-time ATR is read only from frozen
  `decision_observations.features.technical.atr14`.
- Label maturation writes ATR-normalized MAE/MFE and three deterministic,
  versioned, close-observed exit-policy outcomes to `observation_labels`.
- Missing historical ATR remains null. Kairos does not reconstruct it from
  later-adjusted candles.
- The authenticated `/api/analytics/atr-exit-evidence` endpoint reports US or
  India evidence separately at 2/5/10/20-day horizons.
- Candidate status remains `insufficient_sample` below 60 labels or 12
  horizon-adjusted effective observations. No status can activate a policy.
- Label maturation now pages beyond already-completed observations, fixing an
  older backlog-starvation defect that could strand newer labels.

## Safety Proof

- No trading or exit module imports the ATR candidate family.
- The migration adds no trigger, execution RPC, position/cash foreign key, or
  broker dependency. Production dependency inspection returned zero functions
  dependent on the new columns.
- `observation_labels` remains RLS-enabled and service-only.
- PaperTrader, PositionMonitor, live exits, broker proposals, and protective
  orders were not changed.

## Verification

- TypeScript: clean.
- Tests: 1,229 passed, 6 skipped; focused ATR/label suite 15 passed.
- Production build: clean on the final implementation tree.
- Supabase migration `20260722110000_atr_exit_evidence_labels.sql`: applied to
  FinanceOS project `dionkikgdmlaotvtbnfr`; six columns, three constraints,
  RLS, and zero execution dependencies verified.
- Production already has 747 decision observations containing frozen ATR. The
  361 currently matured labels predate that evidence and are intentionally not
  backfilled with reconstructed ATR.

## Next Gate

Evidence must accrue prospectively. Before any paper shadow proposal, Kairos
still requires purged walk-forward evaluation, a locked holdout, drawdown and
turnover comparison, trial-family correction, and explicit owner approval.
