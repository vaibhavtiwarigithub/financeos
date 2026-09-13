# No-clock exit readiness audit — 2026-09-13

## Scope and verdict

Read-only audit of the paper no-clock exit evidence path. No exit, target, stop,
schema, broker setting, production data, or schedule was changed.

**Verdict: the no-clock policy is operating in paper, but its evidence program is
not yet capable of validating that policy. It is collecting a superseded
time-stop counterfactual, not a no-clock control. Do not infer readiness or
restore a calendar exit from the current rows.**

## What is true now

1. The paper monitor removed the time stop on 2026-09-10. The explicit
   `NO TIME STOP` branch at
   `app/api/agents/position-monitor/route.ts:572` leaves the horizon as a
   review/label window only. Mechanical ladder exits and the fresh,
   two-session score-conviction exit remain the actual exit paths.
2. A safety observation exists, not a liquidation policy: after 20 sessions a
   fresh, above-threshold position with no new high raises
   `paper-position-no-new-high` (`position-monitor/route.ts:622,758`). It does
   not close or alter the position.
3. The old exact-horizon ledger remains wired into the monitor
   (`position-monitor/route.ts:595`) and its scheduled producer remains active:
   `kairos-horizon-extension-shadow-us` / `-india`, jobs 123/124.
4. That ledger's approved comparison is specifically "incumbent next-session
   exit" versus an additional 5/10 sessions
   (`features/time-review-exit/FEATURE_ARCHITECTURE.md`, P1;
   `lib/trading/time-review-exit.ts`). It was designed when the incumbent was a
   hard horizon exit. It is therefore not a control arm for the current
   no-clock policy.

## Production snapshot (read-only, 2026-09-13)

| Market | Exact-horizon observations | Review sessions | Eligible | Matured +5/+10 outcomes |
|---|---:|---:|---:|---:|
| US | 2 | 1 | 0 | 0 |
| India | 2 | 2 | 1 | 0 |

Zero outcomes is expected, not a scheduler failure. The most recent US review
was 2026-09-04 and the India reviews were 2026-09-07/08. As of Saturday
2026-09-13, neither has a complete +5 **market-session** forward window. The
cron jobs did run successfully through 2026-09-11; pg_cron success only proves
the HTTP request was queued, but there is no contradictory ledger evidence at
this point.

## Load-bearing gaps

### 1. The old challenger cannot answer the current question

The current policy is: retain until a mechanical stop/target/partial, confirmed
fresh conviction loss, or another explicit risk rule. The time-review outcome
instead asks whether a hypothetical calendar liquidation on the next session
would have beaten a bounded extension. Both can be true data, but their
comparison cannot establish whether an indefinite/no-clock hold is safer or
more profitable than the live policy.

This is the P0 blocker in
`docs/audits/2026-09-12-completion-program.md`: a named, evidence-driven
stalled-position policy plus a matching market-local shadow/replay gate is
still required.

### 2. Indefinite retention has only an alert, not a measured counterfactual

The 20-session/no-new-high alert is a sensible safety tripwire, but it has no
predeclared action, no immutable decision ledger, no outcome labels, no costs,
and no same-entry control. It therefore cannot distinguish a deliberately
patient winner from a stale capital sink.

### 3. Score freshness is an explicit fail-open exposure

The monitor deliberately holds when research is stale or unavailable; it does
not manufacture a score exit. That is safer than acting on stale evidence, but
in a no-clock system it must be measured as an exposure class: duration of
stale coverage, mechanical-protection state, and subsequent outcome. The
current `stale_scores_held` run metric is an alerting signal, not an immutable
per-position evidence ledger.

### 4. Future ledger starvation — repaired locally, pending suite/deployment proof

The original maturer read the oldest 500 observations before checking which
review/extension pairs were already complete. Once the ledger exceeded 500
historical reviews, completed old rows could consume the entire worklist and
newer reviews would never mature.

The local measure-only repair now pages observations/outcome keys, removes
completed pairs before the 500-review budget, and rotates the remaining pending
worklist deterministically by UTC day. Regression tests prove both that a later
pending row is selected after 500 completed rows and that an incomplete old
prefix cannot permanently block a later review. This has no current production
effect (only four rows); it still requires full-suite/deployment verification.

## Required, safe next architecture

Do not retrofit the old time-review trial. Write a narrow **no-clock retention
shadow** architecture first:

1. **Frozen observation at explicit checkpoints:** e.g. 20, 40, and 60 market
   sessions, plus every fresh confirmed conviction-loss event. Store age,
   initial and active protection, high-water/drawdown, exact score freshness,
   and stale-evidence state.
2. **Predeclared non-money candidate arms:** retain under current no-clock
   control; a stalled-risk candidate that would exit only after a named,
   fail-closed condition; and an unavailable-evidence arm that records
   abstention rather than inventing an exit. No adaptive threshold search.
3. **Outcome labels:** market-local forward return, benchmark-relative return,
   MAE/MFE, stop/target/score-exit sequence, capital-at-risk duration, and
   replacement availability. Use the same price/cost/barrier-order conventions
   as paper execution.
4. **Promotion gate:** sufficient distinct checkpoint sessions, purged
   walk-forward/redeployment replay, costs and turnover, adverse-case review,
   and explicit owner approval. A mean per-position return is not enough.
5. **Maintenance proof:** deploy and observe the already-local pending-worklist
   repair under its scheduled producer. This is measure-only plumbing, not an
   exit-policy change.

## Decision

There is no safe code-only completion for the substantive gap: choosing a
stalled-position condition would create a new exit policy and requires an
approved architecture. Until then, keep paper no-clock behavior, collect the
existing legacy ledger as historical context only, and surface its status as
`superseded_for_activation` rather than `collecting toward promotion`.
