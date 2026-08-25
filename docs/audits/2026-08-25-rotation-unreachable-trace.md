# Why US capital rotation stopped on 2026-08-11

Frozen trace, 2026-08-25. Evidence only — no live behaviour was changed by this
document. Triggered by the question "PLTR ran ~30% in a month and we never held
it; what are we missing?"

## Short answer

Nothing was missing in research. PLTR was scored 57 times and passed the
research gate as an eligible long on **30 consecutive sessions** (2026-08-05 →
2026-08-25, analyst 68–77, technical 100). It reached the portfolio constructor
**once**, on 2026-08-21, and was denied. Since 2026-08-18 the constructor has
admitted **zero** candidates on any day, in either market.

The book is full, the release valve is capital rotation, and rotation is
unreachable on the path that now binds.

## The funnel, US, since 2026-08-18

| stage | volume |
|---|---|
| research passed | 592 symbol-days |
| reached risk_plan | 118 (20%) |
| constructor passed | **0**, six consecutive sessions |

Avg analyst score reaching risk_plan 75.9, not reaching 71.4. PLTR at 71–77 sat
on the cut against a book scoring 86–92.

## Root cause: a `continue` that skips rotation

`app/api/agents/paper-trade/route.ts` evaluates rotation at the funding step,
triggered when the book cannot take a candidate as-is (`atNameCap || cashShort`).

An earlier fix removed the `continue` on the NAME-CAP path, with this comment:

> "This used to `continue`, which made the rotation path at the funding step
> unreachable whenever the name cap bound first — the common case... 
> rotation_events stayed empty for 9 days with shadow enabled as a result."

The identical `continue` on the **portfolio-constructor denial** path was left in
place (the `portfolio_constructor / rejected` branch). That branch is now the
binding one: since 2026-08-18 the constructor's terminal reasons are
`gross_cap: N% -> 0.00% (book+candidates would be ~92%, cap 80%)` and
`denied: scaled size 0.000% below minimum viable 0.5%`.

So a candidate denied FOR LACK OF ROOM never reaches the rotation whose entire
purpose is to make room. Same bug as the one already fixed, one gate over.

## Why India kept working and US did not

| | us | india |
|---|---|---|
| paper cash | $2,049 | ₹235,247 |
| binding gate | constructor gross_cap → `continue` | `max_open_names` → falls through |
| `execution / max_open_names` rejects | last 2026-08-11 | continued to 2026-08-24 |
| rotation_events | last 2026-08-11 | continued to 2026-08-24 |

US is gross/cash constrained, so it takes the broken path. India is name-slot
constrained, so it takes the repaired one. The two dates match exactly.

## Rotation could not have helped even if reached

`rotation_config`, all four rows (us/india x paper/live):

```
rotation_shadow_enabled:         true
rotation_paper_execute_enabled:  false
rotation_live_proposals_enabled: false
```

Across **98 rotation_events**, both markets, all time: `trade_proposal_id` NULL
on every row, `paper_trade_ids` NULL on every row. Every event carries
`no_execution: true`, `reason: shadow_rotation_candidate`. Rotation has never
moved capital.

Its own `p1_blockers`: `turnover_budget_not_configured`,
`exact_tax_lots_unavailable`, `score_to_return_mapping_unvalidated`,
`post_swap_gate_unavailable`, `candidate_correlation_unavailable`. Also observed:
`monthly_turnover_used_pct` ≈ 93%, and `missing_fresh_price` blocking up to 13
holdings from being evaluated as sell sources.

## Two documentation claims corrected the same day

Both asserted rotation executes. Both were false, and both are what made this
take a full trace to find.

1. `lib/shadows/registry.ts` — "Paper execution is enabled; live proposals are
   disabled."
2. `app/api/agents/paper-trade/route.ts` — "Capital-rotation P1 PAPER execution
   is live (owner-approved 2026-07-23)."

## What is NOT proposed

Raising the 3-proposals-per-run cap (`trader/route.ts`, `.limit(3)`). That is a
locked CLAUDE.md decision and it is not the binding constraint — the book has
been closed to new entries regardless of candidate volume.

## Open, needs an owner decision

Making the constructor-denial path fall through to rotation restores the
intended design and is measurement-only while
`rotation_paper_execute_enabled=false` (it would resume writing rotation_events
for US). Actually ENABLING rotation to trade the paper book is a separate
money-path decision with the p1_blockers above still unresolved.

---

# CORRECTION — 2026-08-25, same day

Everything above the line stands EXCEPT the claim that rotation has never moved
capital. That claim is false, it is mine, and it propagated into
`lib/shadows/registry.ts`, `docs/arch/08-risk-and-safety.md`, commit
`4b84cc49`, and `decision_journal` id 344. It was also the main argument used
to justify enabling paper execution, which has since been reverted.

## What rotation actually did

Two swaps executed. `rotation_events` recorded both with
`status = 'paper_executed'`:

| date | market | sold | score | bought | score | edge |
|---|---|---|---|---|---|---|
| 2026-07-24 | us | **PLTR** | 56 | CB | 74 | 18 |
| 2026-07-27 | india | ONGC.NS | 53 | TCS.NS | 100 | 47 |

Four sell lots closed with `exit_reason = 'capital_rotation'`:

| market | symbol | opened | closed | realized |
|---|---|---|---|---|
| us | PLTR | 2026-07-16 | 2026-07-24 | -0.10% |
| india | ONGC.NS | 2026-07-14 | 2026-07-27 | -2.50% |
| india | ONGC.NS | 2026-07-23 | 2026-07-27 | -4.13% |
| india | ONGC.NS | 2026-07-24 | 2026-07-27 | -3.05% |

## How the error happened, precisely

`rotation_events.trade_proposal_id` and `.paper_trade_ids` are NULL on every
row including the two executed ones. I read those NULLs as proof of
non-execution while `status = 'paper_executed'` sat in the same rows, and never
cross-checked `paper_trades.exit_reason`. The linkage columns were simply never
populated by the executor.

**Rule this earns:** never infer "did not happen" from an unpopulated foreign
key. Confirm against the table that records the effect — here `paper_trades` —
not the table that records the intent.

## Second correction: "all four rotations lost money" is also wrong

That was my next statement and it is the wrong frame. Rotation SELLS THE
WEAKEST HOLDING by design, so its sell legs are expected to be losses. The
honest unit of evaluation is the swap:

| swap | sold leg realized | bought leg over its own hold | verdict |
|---|---|---|---|
| PLTR -> CB | -0.10% | CB 07-24 -> 08-10: **+0.12%** | ~neutral |
| ONGC.NS -> TCS.NS | -2.50 / -4.13 / -3.05% | TCS 07-27 -> 08-11: **+6.12%** | clearly positive |

On this evidence rotation's two swaps were neutral and positive respectively.
That is not a case against rotation.

## Third correction: rotation is NOT why PLTR's run was missed

PLTR opened 2026-07-16 and rotation closed it 2026-07-24 — 8 calendar days,
about 6 market days, against a 10-market-day horizon. **The unconditional time
stop would have closed it around 2026-07-30 regardless.** Rotation took it out
roughly four sessions early; it did not cost the subsequent move.

The mechanism that actually forfeits runs like this is the time stop, which is
precisely what the horizon-extension shadow (scheduled 2026-08-25, jobs 123/124)
exists to measure.

## What is still NOT established

Why the paper flags were set false on 2026-08-11 03:33:35. The registry says
execution is gated "after unsafe early P1 behavior", but I have not identified
what that behavior was, and the swap P&L above does not obviously explain it.
**Do not re-enable paper execution until that cause is known.** The flags are
back to false; live was never touched.
