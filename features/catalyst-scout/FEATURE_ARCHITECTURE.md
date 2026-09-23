# CatalystScout — Feature Architecture

> Status: **Stage 1 LIVE (measure-only shadow)**. No gate, no sizing, no order-path change.
> Author: Claude (Sonnet 5), 2026-09-18. Approved by Vaibhav 2026-09-18 (item #1 of the
> `achaljhawar/1rok` gap-analysis plan — see PROJECT_DECISIONS.md Decision 79's fast-follow list).
> Sibling document: `features/risk-tier-gate/FEATURE_ARCHITECTURE.md` (same session, same discipline).

## 1. The gap this closes

Kairos's earnings handling has always been **defensive only**: the `±2/5 day` earnings blackout in
`app/api/agents/paper-trade/route.ts` exists to avoid trading INTO an earnings print, and analyst
target upside is explicitly `observational_only` (0 points) in `scoreFundamentals`. Nothing in this
codebase scores catalyst **upside** — an asymmetric near-term setup where the evidence already points
one direction before the print. `achaljhawar/1rok`'s Catalyst agent's prompt discloses a clean,
adaptable scoring shape for exactly this (base 50, components earnings-setup/expectation-asymmetry/
non-earnings-catalyst/insider-signal/event-risk-penalty) — their agent is LLM-judged; this document
adapts the disclosed *shape*, not their implementation, into a deterministic Kairos component.

## 2. Inputs — all already in scope, zero new fetches

Every input `computeCatalystScout` (`lib/scoring/catalyst-scout.ts`) needs is a variable already
computed by the time `research-agent.ts` reaches the `decision_observations` insert:

| Input | Existing source | Was it already fetched? |
|---|---|---|
| `daysToEarnings` | earnings-calendar batch read | Yes — same value the earnings blackout uses |
| `analystConsensusScore` | `lib/data/analyst.ts` `scoreAnalyst()` (Finnhub) | Yes — already fetched, currently only LOGGED (`decision_observations.features.analyst`), never scored, per that call site's own comment: "captured as LOGGED EVIDENCE... NOT fed into the live weighted score yet" |
| `insiderScore` / `insiderAvailable` | `scores.insider_score`, `included.insider` | Yes — the live insider dimension |
| `capitalFlow5d` | `webullExtended.capitalFlow.largNet5d` | Yes — already fetched Webull smart-money flow, already written to `decision_observations.features.capital_flow_5d` |
| `breakdownVetoed` | `scores.evidence.technical.breakdown_veto.vetoed` | Yes — the existing crash/meme-reversal veto |

No new provider, no LLM call, no schema dependency beyond the existing `decision_observations.features`
jsonb column.

## 3. The five components (adapted from 1rok's disclosed ranges)

| Component | Range | Logic |
|---|---|---|
| Earnings setup | -20 to +25 | Only scored when earnings are within 10 days; direction/magnitude from analyst-consensus skew. Known-but-distant earnings contribute exactly 0 (available evidence, no near-term setup) — distinct from unknown (null, excluded) |
| Expectation asymmetry | -15 to +20 | Analyst-consensus skew from neutral (50), independent of earnings timing — a standing asymmetry read, not earnings-gated |
| Non-earnings catalyst | -10 to +15 | Sign of Webull 5-day capital-flow net (this pass: sign only, not magnitude-scaled — see §5) |
| Insider signal | -10 to +10 | `insider_score` skew from neutral, gated on the SAME `insiderAvailable` flag the live composite uses (never reads the default-fill 50 as if it were evidence) |
| Event risk penalty | -25 to 0, always computed | Earnings within 5 days: -15. Active breakdown veto: -10. Both together caps at -25 and forces `classification = "high_risk_binary_event"` regardless of the setup direction |

`totalScore = clamp(50 + sum(available components) + eventRiskPenalty, 0, 100)`.

## 4. Same stated asymmetry as risk-tier

The four evidence-gated components contribute zero, not a neutral default, when unavailable —
`coverage` (0-4) travels with every row for the same reason risk-tier's does. The event-risk penalty
is different in kind: it is a rule (not an evidence read) that defaults to 0 when its trigger
conditions aren't met, which is a defensible "no known reason to flag extra risk," not a fabricated
claim — so it is not counted in `coverage` and always contributes.

## 5. What was deliberately not built (yet)

- **Corporate-actions non-earnings catalysts** (M&A, spinoffs, buybacks — the `corporate_actions`
  table already exists per `system-map.json`) are NOT wired into `nonEarningsCatalyst` this pass; only
  Webull capital-flow sign is. A real event-type read is a natural fast-follow.
- **Capital-flow magnitude scaling** — this pass uses sign only (+8/-6 fixed), not a magnitude-scaled
  contribution. Needs a defensible normalization (vs. float, vs. ADV) before scaling by size.
- **Binary vs. non-binary event classification** (1rok's own distinction: FDA/M&A rulings vs. product
  launches/investor days) is not modeled — Kairos has no data source for non-earnings binary events
  yet.
- Any consumption of `catalyst_shadow` by scoring, sizing, or entry gating — a separate, evidence-gated
  promotion decision, same as risk-tier-gate.

## 6. Acceptance criteria

1. Zero change to `analyst_score`, direction, sizing, entry/exit gates, or any order path.
2. No new provider call, no new fetch — every input already existed in this function's scope.
3. Fail-soft: wrapped in its own try/catch; a thrown error never blocks the research decision it's
   attached to.
4. `coverage` always present so a low or high `totalScore` can be read against how much real evidence
   it rests on.
