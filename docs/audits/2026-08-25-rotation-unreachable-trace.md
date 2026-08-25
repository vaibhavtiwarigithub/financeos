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
