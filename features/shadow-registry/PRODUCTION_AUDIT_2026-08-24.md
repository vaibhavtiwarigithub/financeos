# Upgrade Path production audit — 2026-08-24

Reviewed by Codex / ChatGPT against mainline Git history and FinanceOS production
Supabase project `dionkikgdmlaotvtbnfr`. Counts are operational evidence, not
evidence of profitability. A program can be deployed for measurement while
remaining correctly absent from scoring, paper execution, or live execution.

## Vocabulary

- **Mainline**: the implementation is merged into the app. This does not prove
  that its migration, schedule, flag, evidence writes, or decision consumer is
  active.
- **Production measurement**: deployed code is writing or reading production
  evidence inside a measure-only boundary.
- **Paper impact**: the feature is allowed to change the paper portfolio.
- **Deployed inactive**: code exists in production, but the runtime campaign or
  influence flag is off.
- **Ready for review**: an evidence floor is met. It is not permission to enable
  scoring, paper behavior, or live trading.

## Program-by-program result

| Program | Entered mainline | Production truth on 2026-08-24 | Why it is not at the next stage |
|---|---|---|---|
| Dimension and agent diagnostics | 2026-08-06 · `0a48e791` | Production measurement. Both market schedules are active; 56 runs exist for US and 56 for India, latest 2026-08-21. | Permanently diagnostic. A finding must become a separately governed candidate and pass replay/forward-shadow gates. |
| Decision-label coverage | 2026-08-06 · `1704c18a` | Production measurement through `kairos-label-maturation`; 6,176 US and 1,565 India labels exist. | Permanently measure-only. It determines whether other conclusions are supportable; it is not promotable. |
| Exit-geometry shadow | 2026-08-06 · `b2834f48` | Deployed read-only counterfactual. India has 21 distinct entry-eligible 10-day dates and is review-ready; US has 18/20 and is still collecting. | India still needs a separate architecture/owner decision; the coverage floor alone cannot change exits. US needs two more independent dates. |
| Evidence Router parity | 2026-07-13 · `fc9bace1` | Production measurement. US/India shadow and cohort jobs are active; 32 US and 31 India evaluations exist. Active policy v1 has `router_enabled=false` in both markets. | The old adapter incorrectly called one fresh pass review-ready despite the declared ten-session gate. Fixed to require ten distinct fresh passing market sessions; activation remains market-local and owner-gated. |
| Evidence degradation guard | 2026-07-16 · `eb5bca43` | Production measurement. US has 90 counterfactual events; India has zero events but active evaluation runs. | Zero events can be a valid outcome, not a dead job. Liveness now comes from evaluation runs. Enforce mode still needs false-positive review and a stable market-local baseline. |
| India news and event evidence | 2026-07-31 · `dc1e2960` | India-only production measurement. Daily cron is active; 56 cached evidence rows and 351 metered calls exist. | Source relevance and a deterministic PIT sentiment classifier are not validated; the active India score correctly does not consume it. |
| Setup expert comparison | 2026-07-10 · `6dca1f3c` | **Partially broken.** US has 1,604 rows but only `quality_momentum` and `etf_trend`; India has zero rows. | Migration 163's unique `(observation_id, policy_version_id) NULLS NOT DISTINCT` index permits only one NULL-policy row per observation. India always writes two experts, so the batch conflicts; multi-expert US batches are also untrustworthy. Requires an approved migration with separate challenger uniqueness and `(observation_id, setup_type)` uniqueness, then a market-local backfill/restart. |
| Technical edge calibration | 2026-07-21 · `a249d50e` | Production measurement. Edge jobs are active; 20,528 edge rows and 66 readiness cells exist. US `high_52w_proximity` (20d) and `volume_breakout` (10d) report `ready_for_validation_build`; India remains collecting. The old adapter filtered these ready rows out of Upgrade Path and is fixed to inventory every registered edge. | Review-ready evidence is not a scoring promotion. Both ready cells still have 0/4 cost/FDR validation windows; sealed validation/shadow admission and owner approval remain separate gates. |
| Point-in-time fundamental qualification | 2026-07-10 · `e2cd9b73` | Production measurement. 452 US and 271 India vintages exist, both refreshed on 2026-08-24. | Captured snapshots are not automatically valid historical features. Units, known-at time, revisions, taxonomy, and market-local source qualification remain unresolved. |
| Specialist instrument packs | 2026-08-02 · `4ea20075` | Deployed inert catalog only; no specialist evidence collector or decision consumer exists. | Raw contracts for banks, REITs, leveraged ETFs, metals subfamilies, and other specialists must be qualified one family at a time. |
| Capital rotation | 2026-07-13 · `ac7ffda0` | Production shadow measurement. 54 US and 44 India evaluations exist. Paper execution is currently false in both markets; live proposals are false. | Four early paper rotations were enabled before all P1 gates and had a small negative cohort. Score-only execution is now contained; a safe atomic P1 design, cost/tax evidence, and independent outcomes are required. |
| Earnings event risk | 2026-07-29 · `65c1c5be` | Production measurement. 281 US and 174 India observations exist; US monitor/PIT schedules are active and `behavior_changed` remains false. | US count floors may be review-ready, but usable quote coverage has no predeclared pass criterion and calibration is pending. India intentionally has no options-implied-move gate. Neither market may change behavior without a separate owner decision. |
| India macro and global spillover evidence | 2026-08-01 · `57c63cf3` | Deployed inert schema foundation. There are zero source observations and zero regime-shadow runs. | No approved official timestamped source adapters or market-local PIT validation exist. It must not be described as an active macro scorer. |
| International allocation | 2026-07-27 · `89ca679f` | US-only production measurement. Weekly cron is active and seven assessments exist; policy remains `observe` with target/deadband unset. | Broader family comparison, cost/tax review, target/deadband, and owner approval are absent. India is intentionally not applicable. |
| Autonomous live execution | 2026-07-10 · `e45ca642` | Live-capable code is deployed but inactive. `live_auto_enabled=false`, both modes are manual, shadow crons are absent, and there are zero autonomous-shadow proposals. | No approved evidence campaign, broker canaries, kill-switch drills, or explicit enablement. Deployment of safe code must not be confused with authorization to trade. |
| Strategy challenger validation | 2026-07-12 · `0004eeb8` | Production automation is armed for US and India; weekly validation cron is active. There are zero current `shadow_paper` challengers. | It is waiting for a deterministic-validation passer. An armed empty slot is not a failed deployment and cannot promote itself. |
| Downside hedge | 2026-07-15 · `38a18f0a` | Paper-capable code is deployed but disabled. The US cron remains active, config has `enabled=false` and `paper_execute_enabled=false`, and there are zero events. | No hedge precision/drag campaign is approved. The active self-skipping cron should be retained only if its negligible operational cost is intentional; otherwise unschedule it in a separate owner-approved cleanup. |

## Findings fixed in the Upgrade Path read model

1. Added typed mainline provenance to every registry entry: date, commit,
   implementation scope, and the reason it was merged.
2. Added a separate runtime deployment state with production proof and an
   explicit “why not next stage” explanation.
3. Added current Vercel environment/build SHA to the API response so a user can
   distinguish local output from the deployed build.
4. Corrected Router readiness from “one valid pass” to ten distinct fresh
   passing market sessions, matching its declared activation gate.
5. Corrected the degradation guard so zero counterfactual events do not make an
   otherwise-live evidence job look dead.
6. Corrected earnings-risk messaging so met count floors become review-ready
   without implying the undefined quote-coverage/calibration gate has passed.
7. Exposed the setup-expert idempotency conflict as `blocked` rather than
   silently calling the India program idle.
8. Fixed a client request race where a slower prior-market response could render
   US evidence under an India heading (or the reverse). Responses are now
   sequence-checked and cards render against the API-returned market.

## Deliberately not changed

- No scoring weight, threshold, candidate eligibility, paper fill, exit,
  allocation, live proposal, order, broker setting, or autonomy flag changed.
- No migration was applied. The setup-expert index repair needs explicit schema
  approval because it changes an idempotency constraint on an append-only
  evidence ledger.
- No inactive program was enabled merely because its code is deployed or its
  evidence floor is review-ready.
