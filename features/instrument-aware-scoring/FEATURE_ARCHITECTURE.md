# Instrument-Aware Research and Scoring

**Status:** Approved; P0/P1 measurement implemented; owner-approved dimension-applicability correction deployed on `main` as `ba81cb8e` on 2026-10-20; Vercel production `READY`
**Owner:** Vaibhav
**Architect/Builder:** Codex / GPT-5
**Date:** 2026-08-24

## 1. Problem

Kairos recognizes some funds and metals, but the actionable v1 scorer still
renormalizes one market-level five-dimension policy and caps every ETF-like score
at 65. This makes structurally different exposures look interchangeable: gold
bullion, silver bullion and a gold-miner equity fund can all become an eligible
65. India symbols are also classified as India equities before fund subtype is
known.

The system must model an economic exposure before choosing a tradable vehicle.
It must not create a bespoke model per ticker: that would overfit. The learning
unit is `market × instrument_family × setup × horizon` and promotion requires
independent forward evidence.

## 2. Non-negotiable invariants

- Family/exposure evidence packs remain measurement-only and cannot authorize
  trades. Separately, the scorer must exclude dimensions that are structurally
  inapplicable or explicitly not enabled; these are not evidence and must not
  contribute a fabricated neutral value to a composite. This correction can
  change recorded scores and paper eligibility where the prior applicability
  mask was wrong; it does not change base weights, thresholds, sizing, exits,
  order controls or live-trading flags.
- New positions remain long-only. Holdings exits are never suppressed.
- LLMs may explain evidence or propose a challenger; they cannot mutate policies,
  limits, scores, code or orders.
- US and India never share promotion evidence.
- Missing, stale, disputed or unclassified evidence is unavailable, never neutral.
- Multiple runs for one symbol/session count once in evaluation.
- Near-substitute vehicles (GLD/IAU) represent one exposure, not two independent
  alpha ideas or samples.
- Append-only ledgers are never updated or deleted.

## 3. Canonical taxonomy

The initial families are `operating_company`, `adr`, `bank`, `reit`,
`broad_equity_etf`, `sector_etf`, `thematic_etf`, `fixed_income_etf`,
`gold_bullion_fund`, `silver_bullion_fund`, `gold_miners_fund`,
`metal_producer_equity`, `royalty_streaming_equity`, `india_etf`,
`leveraged_or_inverse_etf`, and `unknown`.

Initial exposure identities include `gold_spot`, `silver_spot`, `gold_miners`,
`us_broad_equity`, `us_sector:*`, `us_rates:*`, and `india_index:*`.
Classification is deterministic, version-stamped and persisted with the immutable
decision. Unknown classification cannot silently inherit a special model.

GDX/GDXJ are miner-company funds, not bullion. KGC/NEM/AEM/GOLD are producers.
FNV/WPM/RGLD are royalty/streaming companies. GLD/IAU are substitute gold
vehicles. India fund symbols such as GOLDBEES.NS and LIQUIDBEES.NS are funds,
not operating companies.

## 4. Evidence packs

Shared completed-session features (trend, participation and volatility) remain
available where applicable. The first measure-only family pack records:

- gold: real-yield change, broad-dollar change, gold return and technical state;
- silver: gold inputs plus silver return and silver-minus-gold relative return;
- miners: gold return, miner return, miner-minus-gold return and technical state;
- funds: benchmark/exposure identity and later qualified spread, premium/discount,
  tracking difference, expense and concentration evidence;
- producer/streamer equities: company evidence remains applicable; commodity
  sensitivity and qualified operational evidence are additive challengers.

FRED series `DFII10` and `DTWEXBGS` are official/free. Price-derived values use
the settled `price_cache` contract. Every field carries source, as-of date,
freshness and status. No family composite becomes actionable in this phase.

## 5. Discovery and selection

Discovery produces exposure candidates. Vehicle selection happens later:

1. detect `gold_spot` opportunity;
2. evaluate the gold evidence pack;
3. if a validated policy is eligible, select one permitted vehicle (for example
   GLD or IAU) using liquidity, spread, tracking and account support;
4. apply portfolio exposure, correlation and money gates.

The existing always-on metal basket stays for evidence continuity, but duplicate
vehicles cannot count as independent opportunities or promotion samples.

## 6. Evaluation and promotion

Diagnostics use the last frozen observation per symbol and market session. They
report independent sessions, usable 5/10/20-session labels, score variance, cap
saturation and excess returns versus the family benchmark. Overlapping horizons
require Newey-West or block-bootstrap uncertainty. A zero-variance/cap-saturated
score has no valid IC.

Promotion is separate per market/family/setup. Minimum starting gate: 60
independent sessions, at least 30 clean out-of-sample observations, non-degenerate
predictions, net-of-cost positive evidence, acceptable calibration and explicit
owner approval. These are floors, not proof of profitability.

## 7. Rollout

1. **P0 — taxonomy and diagnostics:** persist versioned family/exposure context;
   report current cap saturation and label coverage. No score change.
2. **P1 — feature collection:** collect family evidence on every qualifying
   decision. No score change.
3. **P2 — challenger evaluation:** build family-local shadow policies and correct
   benchmarks. No paper/live change.
4. **P3 — isolated exploratory paper:** one exposure-level candidate and dedicated
   risk sleeve after P2 passes.
5. **P4 — active paper:** owner promotion; v1 remains rollback champion.
6. **P5 — live eligibility:** requires separate canary acceptance and owner click.

## 8. Acceptance criteria

- GLD/IAU resolve to `gold_bullion_fund` + `gold_spot`; SLV to silver; GDX to
  `gold_miners_fund`; Indian known ETFs never resolve to `operating_company`.
- Decision observations expose taxonomy version, family, exposure and measure-only
  evidence with timestamps/status.
- Diagnostics deduplicate same-session runs and explicitly reject IC when score
  variance or clean labels are insufficient.
- No new table, route or field is read by paper/live execution.
- Golden taxonomy/evidence tests, full Vitest, production build, migration proof,
  RLS/security advisors and end-to-end production read verification pass.

## 9. Explicitly deferred

Copper, uranium, agriculture, futures/options, leveraged/inverse funds,
intraday models, proprietary DXY, and autonomous promotion are separate designs.
Oil moved out of this list on 2026-09-15 as a measure-only exposure pack only
(§11); oil scoring, eligibility and trading remain deferred.
No performance claim is made until forward evidence exists.

## 10. Implemented baseline (2026-08-24)

P0/P1 measurement is shipped: deterministic taxonomy, immutable family evidence,
an owner-only bounded diagnostics route, uncapped family shadow decisions, and
Research Journal disclosure. Migrations `20260824183930` and `20260824185010`
and hardening migration `20260824190302` are applied and verified in the FinanceOS
project. The second migration backfills
only deterministic taxonomy; it deliberately does not reconstruct historical
feature values.

The initial production audit confirms why promotion is blocked. After collapsing
same-symbol session duplicates, gold bullion has 58 symbol-sessions but only 37
independent exposure-sessions; gold-miner and silver funds each have 23. Cap-at-65
rates are about 47% for bullion and 61% for miner/silver funds. India has no
qualifying historical curated-fund cohort in this ledger yet. These are diagnostic
facts, not evidence of edge; every family remains below the 60-exposure-session
floor and the new features remain non-actionable.

Delivered behavior and verified deviations are recorded in
`features/instrument-aware-scoring/IMPLEMENTATION_RESULT.md`.

## 11. Gold evidence repair and oil exposure pack (2026-09-15)

Owner-approved ("approved, do 1-3") after an audit prompted by oil and gold
moves. Everything here is measure-only: no score, eligibility, sizing, paper,
live, exit or broker path reads it.

### 11.1 Gold evidence audit — what was actually wrong

Production evidence (FinanceOS project, 2026-09-15):

- **Not a defect:** 100 of 168 `gold_bullion_fund` rows have no features. All of
  them are `taxonomy-backfill.v1` rows before 2026-08-25, which §10 already says
  do not reconstruct history. Every live row since 2026-08-25 carries features.
- **Defect 1, mislabeled price window:** `returnPct` returned first-to-last over
  every cached row the shared query returned (~100 rows per symbol, back to
  2026-04-21), not 20 bars. As of 2026-09-11 GLD recorded -7.17% when the real
  20-bar return was -0.05%; SLV -15.14% vs -0.07%; GDX +4.42% vs +10.00%. Fixed to
  exactly the last 20 settled bars; `INSTRUMENT_FEATURE_VERSION` bumped to
  `instrument-family-features.v2`. v1 rows are immutable and must be evaluated
  separately from v2.
- **Defect 2, frozen FRED inputs:** `av_cache` served DFII10 observation
  2026-08-31 for every cache day 2026-09-02..09-11 and DTWEXBGS 2026-09-04 for
  09-12..09-15, while FRED itself had 2026-09-11 for both. Production FRED calls
  failed and `providerCachedFetch` carry-forward rewrote the old payload into each
  new day's slot, so the 7-day fallback bound never expired. The shared-cache
  root cause is tracked as a separate task because it affects every today-only
  provider. In scope here: per-series staleness (DFII10 7d, DTWEXBGS 10d because
  it is released weekly, crude 10d) and a System Health `warn`
  (`family-evidence-fred-stale:<series>`) instead of a silent stale label.

Correction to an earlier chat claim: metals do not fail to trade because of
`scoreMode=measure_only` — no paper path reads score mode. They can enter at the
mandate threshold (52), but `ETF_SCORE_CAP=65` keeps them below equity candidates
that score 66+.

### 11.2 Oil exposure pack

`loadOilExposureEvidence` (same module, same day-cached inputs) attaches
`decision_observations.features.oil_exposure_evidence` for curated symbols only:

| Market | Class | Symbols |
|---|---|---|
| US | crude_oil_fund | USO, BNO |
| US | energy_sector_fund | XLE, XOP |
| US | upstream_producer | OXY, EOG, COP, DVN, FANG, APA |
| US | integrated_major | XOM, CVX |
| US | refiner | MPC, PSX, VLO |
| US | oilfield_services | SLB, HAL, BKR |
| India | upstream_producer | ONGC.NS, OIL.NS |
| India | downstream_marketer | BPCL.NS, IOC.NS, HINDPETRO.NS |
| India | integrated_conglomerate | RELIANCE.NS |

Features: FRED `DCOILWTICO` and `DCOILBRENTEU` 20-observation % change, Brent
5-observation % change, and settled USO 5/20-bar returns (FRED spot crude lagged
6 days on 2026-09-15, so USO is the same-week proxy). Unknown symbols get nothing
— no sector-name heuristic. No expected sign is stored (see §11.3). Deviation from
`features/exogenous-risk-evidence` P2: FRED republishes EIA spot prices under the
existing key, so no new provider; the PPAC Indian Basket stays deferred.
The Research Journal funnel shows the pack as an "Oil exposure · measurement only"
panel next to the family-evidence panel (display only).

### 11.3 Frozen counterfactual — does the oil-sign hypothesis hold?

Read-only, no historical decision rewritten. Last observation per symbol-session,
joined to `observation_labels.benchmark_neutral_return`. Crude = USO settled close:
trailing 10 bars strictly before the decision date; forward window approximated as
`horizon_days × 1.4` calendar days. Evidence is 2026-07-07..2026-09-02.

| Group | h | n (sessions) | corr(crude fwd, excess) | corr(crude trailing 10, excess) | excess when crude up / down |
|---|---|---|---|---|---|
| india_omc (BPCL, IOC) | 5 | 33 (19) | +0.11 | -0.14 | -0.06% (29) / -0.42% (4) |
| india_omc | 10 | 33 (19) | +0.54 | -0.39 | -0.44% (29) / +2.38% (4) |
| india_upstream (ONGC) | 10 | 16 (16) | +0.86 | -0.89 | -4.51% (12) / +0.66% (4) |
| india_integrated (RELIANCE) | 10 | 7 (7) | -0.06 | -0.18 | -0.45% (4) / -0.20% (3) |
| us_upstream | 10 | 19 (19) | +0.94 | -0.67 | -0.50% (17) / +8.64% (2) |
| us_integrated | 10 | 20 (20) | +0.90 | -0.58 | -0.26% (18) / +7.02% (2) |
| us_refiner | 5 | 8 (6) | +0.83 | -0.51 | +5.82% (3) / +6.74% (5) |

Findings, stated at the strength the data allows:

1. US energy and India upstream move with crude over the same window, as expected.
2. **The "OMCs are hurt when crude rises" sign is not supported.** BPCL/IOC excess
   returns co-moved weakly positively with crude. The earlier chat warning was
   textbook reasoning, not evidence, and is withdrawn as a rule candidate.
   BPCL's paper losses came from 11 re-entries in three weeks closed by time stops,
   not from benchmark underperformance (BPCL 5-day excess was +0.37%, 15/22 positive).
3. Every group shows negative correlation between the trailing crude run-up and the
   next window's excess return: entries made after crude rallies lagged. This is
   one regime (crude +34% in July then -14% in late July), overlapping windows,
   2-3 symbols per group, and a US-listed crude proxy on Indian dates. It is a
   hypothesis for the new pack to test forward, not a rule.

Gate before any oil feature becomes actionable: the §6 floors per market and exposure
class (60 independent sessions, 30 clean out-of-sample observations), measured on v2
evidence with Newey-West or block-bootstrap uncertainty, plus owner approval.

## 12. Owner-approved dimension applicability correction (2026-10-20)

The owner explicitly requested that dimensions which do not describe an
instrument must not affect its composite and that the UI identify why. The
ResearchAgent now uses a single versioned applicability contract to distinguish:

- `applicable`: the factor belongs in this instrument/market's current formula;
  whether fresh data is present is decided separately for that run;
- `not_applicable`: the factor is structurally meaningless for the instrument;
- `not_enabled`: the factor may be relevant, but no qualified factor is active
  in that market/formula.

Only an `applicable` dimension with usable evidence enters the weighted score.
This fixes India-listed ETF classification order, prevents India-only-disabled
sentiment/macro/insider feeds from slipping into the score when available, keeps
US ETF company financials/insiders and ADR Form-4 insider scoring out, and
excludes the neutral REIT fundamental placeholder until an FFO/AFFO contract is
implemented. Evidence-only options/analyst collection remains limited to US
common equities and ADRs; canonical ETF classification is applied even if an
upstream row omits its ETF flag.

Every new decision observation stores
`features.dimension_applicability = {version, dimensions}` with a reason for
each factor. Research Journal labels `Not applicable`, `Not enabled`, `Missing`
and usable/degraded evidence distinctly; excluded dimensions show zero weight,
zero contribution and no misleading evidence payload. No schema is added because
the record is stored in the existing decision-observation JSON feature field.

This is a scoring-behavior correction, not the instrument-family shadow being
promoted. Because an applicability mask can change the effective weight split,
historical IC must remain code-version separated; do not compare pre- and
post-correction scores as if they were generated by one formula. India funds may
have only technical evidence under the current active five-dimension contract;
the existing minimum-two-dimensions abstention remains in force, so no trade is
manufactured until a second qualified factor exists. No new dimension, weight,
threshold, market-data source, or live permission is introduced.

## 13. Family/direction-aware score challengers (owner proceed, 2026-10-28)

### Hypothesis and boundary

The owner asked whether a favorable underlying-market macro score should help a
long exposure and hurt an inverse exposure, and whether each instrument family
uses only economically meaningful dimensions. The hypothesis is that an
explicitly underlying-referenced signal can be direction-oriented by exposure
and can improve forward prediction for the corresponding family. This is not
assumed true, and the incumbent score remains unchanged.

This phase is shadow/diagnostic only. It may persist candidate values alongside
the existing immutable decision evidence and evaluate them on matured, matched
forward labels. It must not change the production composite, entry eligibility,
rank, sizing, stops, paper/live decisions, or council prompt/models. Unknown
family, ambiguous signal semantics, stale source, and missing exposure mapping
mean `not_evaluated`, not a neutral score or inferred sign.

### Semantic contract

Applicability and direction are separate fields. A dimension can be applicable
but must not be flipped unless its value explicitly describes the underlying
exposure's prospective return. The candidate contract records per input:

- `dimension`, `instrument_family`, `exposure_id`, `reference` (`instrument`,
  `underlying`, `sector`, `commodity`, `rates`, or `macro_regime`),
- `direction` (`+1`, `-1`, `0`, or `unknown`), `transform_version`,
- source/as-of/freshness/applicability and an exclusion reason.

For the first bounded challenger, only a score whose documented meaning is
prospective favorability of the underlying equity exposure may use the inverse
orientation `100 - score` for an inverse fund. Fund-price technicals remain in
the fund's own direction. Social/news sentiment is never inverted unless its
source identity proves it refers to the underlying. Leverage magnitude, daily
reset, volatility, gap and tracking risk are separate risk/eligibility evidence,
not bullish or bearish alpha points.

The first comparison is limited to existing US broad-equity / semiconductor
long and inverse instruments with known underlyings (including SPY/QQQ/SOXX,
SOXL/TQQQ, and SOXS/SQQQ where valid observations exist). It reports incumbent
versus one predeclared direction-aware challenger on the same symbol/session
population and h2/h5/h10/h20 labels. A shared market-level macro value cannot
rank names cross-sectionally; its effect is evaluated as a dated time-series or
family-relative outcome, never mislabeled as cross-sectional IC.

Gold, oil, silver, rates, India families and crypto require signal-specific
economic-reference mappings and separate cohorts. Existing measurement-only
evidence is not pulled into the actionable composite by this work. No universal
sign table is inferred from names like "macro" or "sentiment".

### Data, evaluation, and presentation

Reuse immutable `decision_observations` features, current applicability state,
the existing matured benchmark-neutral labels, dimension/score-variant
evaluators, and Learning/Prediction Lab result surfaces. Prefer a JSON evidence
addition and existing append-only result contracts over another shadow table.
Do not rewrite prior rows or backfill a new formula identity with old outcomes.
If those existing contracts cannot represent the challenger and actual
availability/provenance without ambiguity, stop and amend this architecture
with the smallest required schema/migration before writing code.

Required readout: version, reference direction, applicability and availability,
matched and excluded counts/reasons, per-market and per-family results, horizon,
descriptive rank IC, dependence-aware uncertainty only where the existing
minimum gates allow it, and paired incremental result versus incumbent. No
promotion or claim of skill with insufficient/negative evidence. Compare only
on untouched forward sessions after the challenger is frozen.

### Acceptance and rollout

1. Golden semantics prove long-equity and inverse underlying signals have
   opposite orientation, while own-instrument technicals and ambiguous
   sentiment are not flipped.
2. Unknown, stale, structurally inapplicable, or unmapped evidence cannot
   contribute a value; US and India remain separate.
3. Challenger and incumbent are evaluated on exactly matched observations and
   matured labels; duplicate same-session decisions count once.
4. No production score or trading behavior changes. Any later promotion needs
   its own review against the family/horizon evidence floor and explicit owner
   decision.
5. Update the ResearchAgent and Learning architecture chapters, focused tests,
   and this implementation result before calling the collector live. Natural
   scheduled observations—not manually invoked trade jobs—prove collection.

### Out of scope

No new provider, live browsing by council models, additional LLM calls, universal
macro score, per-symbol fitted weights, entry/exit policy, leveraged trade
activation, risk relaxation, or automatic score mutation. Detailed council
explanations and portfolio replay are separate workstreams documented in their
own architectures.
