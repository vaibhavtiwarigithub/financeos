# Instrument-Family Scoring Doctrine

**Status:** Architecture doctrine; family features remain measure-only
**Last updated:** 2026-08-24

## Principle

Classify the economic exposure before choosing the tradable vehicle. Do not use
one generic company score for bullion, a miner fund, a bank and an operating
company; also do not build one model per ticker. The learnable unit is bounded:
`market × instrument family × setup × horizon`.

GLD and IAU are substitute vehicles for one `gold_spot` idea. They are not two
independent alpha observations. GDX is a portfolio of mining companies, not
bullion. KGC is a producer; FNV is a royalty/streaming company. India evidence
and promotion remain separate from US evidence.

## Metals evidence hierarchy

For bullion challengers, measure price trend together with real-yield and broad
dollar changes. For silver, also measure silver-versus-gold relative strength.
For miner funds and companies, also measure miners-versus-gold relative strength;
company fundamentals remain applicable to an operating miner but not to bullion.

The World Gold Council describes gold as influenced by economic expansion, risk
and uncertainty, opportunity cost (including rates) and momentum. CME likewise
highlights supply/demand and macro drivers for gold and silver. These sources
justify measuring candidate drivers; they do not prove a profitable formula.

- World Gold Council: https://www.gold.org/goldhub/research/the-impact-of-monetary-policy-on-gold
- CME Group: https://www.cmegroup.com/insights/economic-research/2026/beyond-demand-supplys-pivotal-role-in-gold-silver-prices.html

## Evidence and promotion rules

- Missing or stale drivers are unavailable, never a neutral 50.
- Repeated runs in one market session count once.
- Substitute vehicles in one exposure/session count once.
- A cap-saturated or near-zero-variance score has no valid ranking IC.
- LLMs may propose or explain features; deterministic statistics validate them.
- US and India require separate forward evidence and owner promotion.
- Until a challenger passes its gates, its maximum influence is explanation and
  shadow measurement—never scoring, sizing, entry, exit or broker execution.

Implementation contract:
`features/instrument-aware-scoring/FEATURE_ARCHITECTURE.md`.
