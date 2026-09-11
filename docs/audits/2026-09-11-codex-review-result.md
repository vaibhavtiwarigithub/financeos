# 2026-09-11 Codex review result

Scope: evidence audit of `CODEX_REVIEW_2026-09-10.md`, current production
read-only data, and the unstaged/staged worktree as found on 2026-09-11.
No trade, configuration, schema, or broker mutation was made by this review.

## Verdict

Do **not** enable autonomous live trading. `live_auto_enabled` remains off.
The live-exit-ladder implementation currently in the worktree is not safe to
ship until the items below are corrected and independently verified.

## Release blockers in the live ladder worktree

1. `lib/trading/live-exit-monitor.ts` skips every reconstructed position where
   `p.qty < 1`. US equities can be fractional; a 0.5-share live holding would
   receive neither a shadow decision nor a protective exit. The code elsewhere
   explicitly says US fractions are supported. Fix: reject only `p.qty <= 0`,
   retain whole-share rounding only for India, and add a fractional-US
   stop/target parity test.
2. A partial target stamps `live_position_state.partial_taken_at` after
   `executeApprovedOrder(...).ok`. Submission is not a fill. A rejected,
   expired, or zero-fill broker order can therefore permanently suppress the
   target branch. Fix: persist a pending proposal reference separately; set
   `partial_taken_at` and `partial_qty` only after reconciliation observes a
   non-zero filled SELL quantity. Handle partial fills explicitly.
3. The position reconstruction query reads only `broker_orders.status =
   'filled'`, while the duplicate guard recognizes `partially_filled`. That
   means a partial fill is neither reflected in the reconstructed quantity nor
   committed to ladder state. Fix: use actual filled quantity for terminal and
   partial states, reconcile until terminal, and prove no duplicate sell is
   possible during that interval.
4. Decision 74 requires a live exit when the fresh score falls below the entry
   threshold and on a confirmed direction flip. The live monitor currently
   implements trail/target only; it does not read a current signal or evaluate
   either rule. Fix: share the fresh-score and two-session direction-flip policy
   with paper before calling this parity.
5. Shadow mode writes `live_position_state`, so pre-enable shadow observations
   become live trailing anchors later. Fix: either keep shadow state isolated
   from executable state or define an explicit enable-time initialization and
   prove it cannot inherit a stale high/partial flag.
6. The state upserts do not check returned errors. A silent state-write failure
   reopens the duplicate-partial and non-ratcheting-stop hazards. Fix: fail
   closed for a live protective action when state persistence fails and emit a
   health incident.

These are findings against uncommitted files owned by another active session.
They were not edited by this review to avoid overwriting concurrent work.

## Remediation update (2026-09-11)

The owner approved remediation. The implementation now:

- preserves six-decimal US quantities in autonomous sizing and Guardian exits;
  India remains whole-share. Robinhood's per-order tradability preflight remains
  the final authority, so an OTC/non-fractional symbol is still refused rather
  than guessed eligible;
- reconstructs partially-filled broker orders from `filled_qty` only, never the
  requested quantity;
- records a partial target only from a broker-confirmed non-zero target SELL
  fill, not from submission;
- isolates shadow state from executable state through an explicit `state_mode`;
- adds score-below-entry and two-session direction-flip evaluation to the live
  monitor using the same session-validity policy as paper; and
- fails closed and raises a critical health incident when executable ladder
  state cannot be persisted.

The corrective migration is
`20260911122939_live_exit_ladder_safety.sql`. It has **not** been applied:
the linked production project has a large migration-history divergence (remote
versions are absent from this checkout), and Supabase correctly refused even a
dry-run push. Do not repair history or force-push this migration; reconcile the
repository migration history with the linked project first, then dry-run and
apply this one migration.

## Time-stop finding

Decision 74 correctly removes calendar exits, but its statement that a
"stalled winner" necessarily exits through a ratcheting trail is false. If a
position never records a price above entry, `highest_price` remains at entry and
the stop never ratchets. It can remain open indefinitely while its score stays
above entry, direction remains long, and price remains above the initial stop.

This is not a reason to silently restore a time stop; that would violate the
owner decision. The required correction is a named, evidence-driven review
rule, proposed separately and shadowed first, plus a backtest policy aligned to
the no-clock live policy. The existing time-review shadow is the appropriate
place to collect that evidence.

## Sizing re-derivation (read-only, h10 labels)

All results exclude tainted and learning-excluded closed lots. Each executed
trade was linked through `signal_id` to its immutable decision observation. Its
10-session forward return was compared only with other entry-eligible long
decisions from the same market and decision date. Missing labels were excluded,
not treated as zero.

| market | clean closed | h10 matched trades | median eligible controls | traded h10 mean | controls h10 mean | difference |
|---|---:|---:|---:|---:|---:|---:|
| US | 62 | 46 | 52 | -1.48% | +1.49% | -2.97pp |
| India | 126 | 94 | 25 | +2.44% | +2.18% | +0.26pp |

Spearman notional versus realized trade return is -0.109 in US and -0.213 in
India. Notional versus the immutable h10 label is +0.043 in US and -0.265 in
India. This rejects the claim that one common sizing inversion is established
across both markets. It does not establish an alternative sizing rule. Keep
equal-risk sizing and volatility-scaled geometry shadow-only until a frozen,
market-local counterfactual clears its stated evidence bar.

## External dependency correction

The claimed 2026-09-14 retirement of `deepseek-v4-pro` is unsupported by the
current official DeepSeek documentation. The official models/pricing page still
lists `deepseek-v4-pro`; only legacy `deepseek-chat` and
`deepseek-reasoner` have a documented retirement date. Do not change the
reasoning alias or pricing on the strength of the brief's claim. Re-check the
official page before any future provider migration.

## Verification completed

- `npx tsc --noEmit` passed.
- `npx vitest run tests/exit-ladder-parity.test.ts tests/kill-and-exit.test.ts tests/trading-mandate.test.ts` passed: 46 tests.
- `git diff --check` and `git diff --cached --check` passed.
- Post-remediation: `npx tsc --noEmit` and 66 focused live-exit, Guardian,
  fractional-sizing, ledger, and direction-flip tests passed.
- Production reads confirmed 213 closed lots, 188 clean lots, 8,501 decision
  observations, and 3,619 matured h10 labels at the time of the audit.
