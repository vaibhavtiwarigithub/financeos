# Upgrade Path Causal Performance Attribution

Status: APPROVED — owner instruction, 2026-09-18
Owner: Vaibhav
Scope: Upgrade Path governance and evidence reporting only. No score, sizing,
paper, live, broker or execution behavior changes.

## Decision

Every Upgrade Path entry must show one of four explicit attribution states:

1. `measured` — a predeclared baseline-versus-variant comparison exists on the
   same market, common evaluation window, same eligible population, and cost
   model. It reports incremental portfolio return, benchmark-relative return,
   uncertainty, drawdown and turnover.
2. `collecting` — the program can affect a portfolio eventually, but its matched
   outcome window is not mature. It reports the exact missing sample/session
   gate, never an estimated gain.
3. `not_attributable` — the program is operational or descriptive only (for
   example data freshness, diagnostics or health), so a portfolio-return number
   would be a category error. It states the operational proof instead.
4. `invalid` — a purported result failed provenance, common-window, baseline,
   cost, independence, or version checks. It is visible as invalid and cannot
   make a path review-ready.

`ready_for_review` continues to mean only that the path's declared evidence
gate is met. It is not a return forecast, approval, or deployment action.

## Causal contract

One append-only `upgrade_path_attribution_runs` row represents one immutable
comparison for one `{program_id, market, program_version, baseline_version,
as_of_session}`. The row stores:

- comparison type: `matched_replay`, `paper_cohort`, `operational_only`;
- start/end session and non-overlapping evaluation horizon;
- baseline and variant portfolio returns, same-window benchmark return, and
  incremental return (`variant - baseline`);
- net-of-cost incremental return, turnover, maximum drawdown delta, number of
  independent sessions, confidence interval and t-statistic where meaningful;
- matched population hash, point-in-time input hash, mandate/strategy versions,
  cost-model version, and a validity/reason field.

No result may combine US and India, use a different candidate population on the
two arms, overlap its nominal independent sessions, compare gross variant return
to net baseline return, or attribute a result across a mid-window program/mandate
version change. Any such mismatch writes `invalid` rather than a number.

## Program eligibility

Only programs with a predeclared decision alternative may eventually use
`matched_replay`: exits, entry/selection challengers, capital rotation,
allocation, sizing and strategy variants. Their report must compare the same
eligible decisions on the same dates before declaring portfolio impact.

Programs that become paper-active use `paper_cohort` only after a frozen
activation date and an otherwise unchanged control/baseline. If simultaneous
changes prevent isolation, the result is `invalid`, not attributed.

Purely operational paths are permanently `not_attributable`. They may report
data coverage, outage avoidance or correctness proof, but never a hypothetical
portfolio uplift.

## UI

Each Upgrade Path card gains an **Attribution** section:

- state pill and comparison type;
- “Since” date and baseline/variant versions;
- incremental net return, benchmark-relative incremental return, 95% interval,
  independent-session count, turnover and drawdown delta when `measured`;
- exact blocker when `collecting`;
- explicit explanation when `not_attributable` or `invalid`.

The page footer repeats that an observed incremental return is historical
evidence, not a forecast. A path cannot be called beneficial from an unpaired
P&L total or from aggregate portfolio performance after multiple releases.

## Acceptance criteria

1. Every registry entry declares its attribution class; no silent default.
2. The status API returns an attribution object for every entry.
3. UI renders the state and never substitutes a generic benefit label for a
   causal result.
4. Tests reject mixed markets, version drift, mismatched windows, gross/net
   comparisons, missing costs, and overlapping-session claims.
5. No writer or consumer may promote/enable a strategy from attribution alone.
