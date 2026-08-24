# Instrument-Aware Research and Scoring

**Status:** Approved; P0/P1 measurement implemented
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

- Existing v1 score, paper selection and every live-money path remain unchanged
  during measurement. New fields are `measure_only` and cannot authorize trades.
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

Copper, uranium, oil, agriculture, futures/options, leveraged/inverse funds,
intraday models, proprietary DXY, and autonomous promotion are separate designs.
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
