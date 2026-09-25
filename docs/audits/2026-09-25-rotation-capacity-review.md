# Capital rotation and monitoring review — 25 September 2026

## What the BE evidence actually says

The September 18 US shadow record compared Bloom Energy (BE), score 80, with
Marathon Petroleum (MPC), score 70. The configured minimum advantage was 12;
the observed advantage was 10. A missed subsequent rally does not establish
that this trade should have passed its contemporaneous decision rule.

The execution journal confirms the immediate rejection was the **80% gross
exposure cap**, not lack of cash: $1,968.47 was available, `cashShort=false`,
and the rotation executor returned `execute_disabled`. The constructor reduced
20% requested sizing to the 12% name cap and then to zero at the gross cap.

The record nevertheless exposed implementation defects: proposed allocation
19.55% versus feasible post-sale capacity 4.42%, and 120.04% reported monthly
rotation turnover when the September executed-rotation ledger contained no
executed rotations. The local fix now charges only completed rotations.

## Current production state (read-only check, 2026-09-25)

The live paper pools currently exceed the owner's requested portfolio shape:

| market | open names | configured name cap | cash | NAV | cash / NAV |
|---|---:|---:|---:|---:|---:|
| US | 13 | 15 | $3,079.49 | $9,998.74 | 30.8% |
| India | 14 | 15 | ₹215,774.31 | ₹1,062,805.85 | 20.3% |

The requested 8-name and <=5%-cash policy is not active. No position was sold
and no mandate was changed in this review. Lowering the database cap alone would
not reduce the legacy book, and a one-for-one replacement cannot consolidate it;
a forced sell-down needs its own risk-approved selection policy. The cash target
also cannot be a hard invariant: exposure/sector/volatility limits and lack of
investable candidates can legitimately leave more cash.

Fresh production rotation events from 2026-09-25 continue to show the P1 blockers.
For one India candidate, score/return evidence had 933 raw pairs but only 4
overlap-adjusted independent sessions versus 20 required; candidate correlation
had 13 matched observations versus 60 required; exact cost-basis/tax lots were
unavailable; and post-swap risk/correlation verdicts were unavailable. A separate
production event reported 209.6% monthly turnover usage, but this was recorded by
the still-deployed pre-fix implementation: India's September ledger contained 127
planned/rejected events and **zero `paper_executed` rotation events**. The local code now derives
turnover from completed rotations only. Therefore 209.6% is not realized rotation
turnover and must not be treated as actual budget consumed; verify the metric after
deployment.

## Repairs

- Preserve desired NAV allocation before cash bounding. Zero cash must reach
  rotation evaluation, not disappear through a zero-quantity rejection.
- Cash, name-count, sector-count and exposure constraints route to replacement
  evaluation after non-capacity entry checks pass.
- Consider sellable holdings from weakest score upward; skip replacements that
  cannot create capacity. Size against the post-sale book, including sell
  slippage, whole/fractional-share rules and existing risk caps.
- Count only completed paper rotations against rotation turnover. Normalize
  two-leg slippage against replacement buy capital: equal-sized legs cost
  0.10%, not 0.05%, under the existing 5-basis-point-per-leg paper model.
- Reject nonfinite evidence and stop/target-crossed sources. Ordinary exit
  processing retains ownership of positions already due to exit.
- Bind execution to the evaluated source, quantity, price and candidate
  allocation. The atomic RPC checks that contract under the source row lock;
  old callers without it fail closed. Forward ordinary entry policy, mandate,
  horizon, name/sector and notional caps into the atomic buy leg.
- Stop further entry processing for that market after a successful swap rather
  than using stale cached book/cash values in the same run.
- Preserve existing IC regression alerts when evidence becomes absent or
  immature. Resolve only series with a measurable latest version and a valid
  historical comparison, not an entire market because no new alerts fired.
- SEC discovery requests already-publishable ET filing dates, processes index
  failures independently, and reports partial/unavailable rather than an empty
  successful day. Primary schedule is Tuesday–Saturday 08:35 UTC, with one
  conditional retry at 11:35 UTC. SEC source access still needs deployed proof.

## Applied database changes

- `20260925160844`: US and India code-version IC reconciliation schedules.
- `20260925163623`: atomic paper-rotation proof and entry-policy forwarding.
- `20260925164004`: SEC publication-aware primary and bounded retry schedules.
- `20260925220447`: owner-readable, service-written missed-entry counterfactual
  ledger. Applied and verified; API/UI deployment remains pending.

Migration versions match production migration history. The rotation function's
plan guard, name/day cap forwarding and removal of cost-price fallback were
queried and verified after application. No trade or portfolio mutation was
performed during verification. US and India execution and score-only flags
were both false after the migration; these repairs do not turn them on.

## Still not established

This is not a validated optimum allocation or a forecast of BE returns. The
matched score-to-return lower confidence bound, complete remaining-book
correlation, persistence and exact cost-basis evidence must pass for a concrete
swap. Statutory taxes and live broker rotation are not implemented here.

The eight-name / at-most-5%-cash request also needs an explicit legacy-book
transition: both books had 15 names and construction still defaulted to 80%
gross exposure at inspection. A one-for-one swap cannot consolidate 15 into 8.
Do not label this policy active or force liquidation to meet it as a side effect.

The working folder also contains unrelated live-execution work. Verification
and shipping of this review use a separate checkout containing only these
repairs. Local success must not be presented as proof of a deployed run.

Isolated-checkout validation: **3,333 tests passed, 7 skipped, 0 failed**.
Two pre-existing source-text assertions were made CRLF-safe; their substantive
security checks remain unchanged. The larger working folder passed 3,436 tests
at an earlier checkpoint, but that includes unrelated uncommitted work and is
not the release verification count.
