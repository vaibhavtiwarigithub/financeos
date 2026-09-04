# Robinhood Crypto — Feature Architecture

> Status: **DRAFT — architecture only. Awaiting Vaibhav's approval before Builder work.**
> Author: Claude (Sonnet 5), Architect role. 2026-09-04.
> Reopens `PROJECT_DECISIONS.md` Decision 2's crypto exclusion — see §0 and the paired decision
> entry below. Scope: PAPER trading only. No live order, no migration applied, no scoring change
> is authorized by this document.

## 0. What this reopens, and what it doesn't

Decision 2 (2026-06-27) excluded crypto from the original long-only equity/ETF scope. This
document proposes amending that exclusion for **paper trading only** — the same starting point
every other asset class in this codebase got (US equities started paper, India started paper,
ETFs started paper). Live crypto trading is explicitly **not** proposed here; it would need its
own future decision after paper history exists, exactly like equities' own L3/L4
`lib/autonomy.ts` ladder already requires for everything else.

## 1. Verified current state

- Zero cryptocurrency-trading code exists anywhere in `lib/` or `app/` — confirmed by grep for
  every real crypto-trading reference (`place_crypto_order`, `BTC-USD`, `cryptocurrency`, etc.).
  Every other "crypto" hit in the codebase is Node's `crypto` module (hashing/encryption) or
  unrelated (`lib/property/crypto.ts`).
- Robinhood's MCP surface has real write capability: `place_crypto_order`, `preview_crypto_order`,
  `cancel_crypto_order`, plus reads (`get_crypto_positions`, `get_crypto_orders`,
  `get_crypto_quotes`, `get_currency_pairs`, `get_crypto_account_onboarding_info`). None are
  allowlisted or called by Kairos's `lib/robinhood-mcp.ts` today (`ROBINHOOD_RESEARCH_READ_TOOLS`
  covers only earnings + options data).
- **Unverified**: whether the agentic account is actually crypto-onboarded at Robinhood
  (`get_crypto_account_onboarding_info` was not called this session — no live MCP session
  available). This is Stage 0, not assumed either way.
- `market` is `check (market in ('us','india'))` on at least 34 migrations across the schema.
  **Crypto must NOT become a third `market` value** — that blast radius (rewriting 34+ CHECK
  constraints) is disproportionate to what's needed, and every session/timezone primitive in this
  codebase (18 files hardcoding `America/New_York`/`Asia/Kolkata`, 11 files building purge/embargo
  logic off a trading-day calendar) is written for exactly two markets.
- The right existing mechanism already exists and is already live:
  `lib/scoring/instrument-taxonomy.ts`'s `InstrumentFamily` union (`operating_company`, `adr`,
  `bank`, `reit`, five ETF families, three metals-adjacent equity families, `india_etf`,
  `leveraged_or_inverse_etf`, `unknown`) plus `InstrumentPolicy.scoreMode: "legacy_v1" |
  "measure_only" | "blocked"`. This registry was **already built for staged rollout of exactly
  this kind of non-standard instrument** — gold/silver bullion funds, miners, royalty streamers
  all got their own family with their own benchmark/exposure/score-mode before being trusted.
  `decision_observations.features.instrument_family_evidence` already has 119 measure-only rows
  from this system running live. Crypto reuses this, not a new mechanism.

## 2. Design

### 2.1 Market stays `"us"`, family becomes `"crypto"`

Robinhood crypto settles in USD through the same agentic account already used for US equities.
Add `"crypto"` to `InstrumentFamily`, `market: "us"`, `scoreMode: "blocked"` initially (matching
the registry's own existing precedent — a family starts `blocked`, earns `measure_only`, then
`legacy_v1` only after evidence). No `market` CHECK constraint anywhere needs to change.

### 2.2 The 24/7 problem — the one genuinely new piece of infrastructure

Crypto trades every hour of every day; every purge/embargo/session-fold/repricing-barrier
primitive in this codebase assumes a closed market with a definable "next session." Two options,
and this document picks the second:

- **(a) Bend crypto into the existing session model** — pick an arbitrary daily UTC cutoff and
  call it "the crypto session close." Rejected: this manufactures a fake session boundary for an
  asset that has none, and every purge/embargo calculation (`walkForwardFolds`, the h2/h5/h10/h20
  forward-return labels) would be silently measuring something different from what it measures for
  equities — a stealth basis mismatch of the exact shape this codebase's own dimension-diagnostics
  work has repeatedly found and fixed (edge-readiness's flat-vs-horizon-aware spacing bug, the
  quote cross-check's session mismatch).
- **(b) A declared crypto session convention, explicit and separate.** A fixed daily UTC cutoff
  (e.g. 00:00 UTC) IS used, but it is documented and coded as `CRYPTO_SESSION_CUTOFF_UTC`, a
  **convention for aggregation, not a claim about market structure** — the way `earnings-pit.ts`'s
  own comments distinguish a real fact from an operational convenience. `walkForwardFolds`,
  `computeSpearmanIC`'s date-clustering, and any purge/embargo logic that touches crypto rows must
  read this constant rather than the market-timezone functions used for `us`/`india`. This is a
  genuinely new piece of shared code (`lib/data/crypto-session.ts`), not a reuse of the existing
  `America/New_York`/`Asia/Kolkata` functions with a new timezone bolted on — a fake "always open"
  timezone would break every place that assumes a session has a close.

### 2.3 Scoring composite — reuses the ETF precedent, doesn't invent a sixth dimension

Crypto has no P/E, no earnings, no analyst coverage, no insider transactions. Four of the five
existing scoring dimensions (`fundamental`, `insider`, and effectively `sentiment`'s current
news-driven sourcing) are structurally inapplicable or thin. `scoreFundamentals` already has a
neutral-baseline branch for ETFs (`isEtf` parameter) — crypto gets the same treatment, not a new
dimension:

- `fundamental`: neutral baseline (matches ETF precedent) — `dq.fundamentalDataAvailable = false`,
  excluded from the weighted composite via the existing `included`/renormalization mechanism
  (`computeWeightedAnalystScore`), not a fabricated neutral-50.
- `technical`: fully applicable — RSI/EMA/momentum compute the same way off crypto candles.
- `sentiment`: applicable if a crypto-relevant news/social source exists (needs a Stage 0
  provider check — Alpha Vantage's news-sentiment endpoint covers some crypto tickers; unverified
  for Kairos's specific candidate list).
- `macro`: the existing US macro regime applies as-is; crypto is a US-account instrument.
- `insider`: not applicable (no insiders) — excluded, same mechanism as ETFs.

Net: a 2-3 dimension composite (technical, sentiment if available, macro), renormalized through
the exact mechanism that already handles a dimension being unavailable — no new scoring function.

### 2.4 Genome — reuses existing bounds, does not fork per-family yet

Per the paired research plan (`docs/audits/2026-09-04-broker-capability-expansion-plan.md` §4),
genome stays shared with equities for now. The one parameter worth flagging for Vaibhav's
attention: `horizon_days ∈ {2,5,10,20}` and `sizing.cap_pct [5,15]` were bounded for equity
volatility; crypto's realized volatility is materially higher, so the *existing* bounds may
already be conservative enough to be safe (a wide stop/target band absorbs more volatility) — this
needs measurement once paper data exists, not a guess now. No genome change proposed in this
document.

### 2.5 Paper pool — new, not shared with the US equity pool

Reusing the existing $10k US equity paper pool would let a crypto flash-crash swing the account
NAV a paper-equity strategy is being judged against, contaminating the exact comparison the
Alpha Diagnostic Lab and champion/challenger validation depend on. Precedent: India got its own
₹ pool for exactly this kind of contamination reason (Decision "Cross-market Trading Mandates").
Proposed: a third pool, `paper_portfolio` row keyed `(market='us', instrument_family='crypto')` or
an equivalent scoping column — exact schema left to the migration design, not committed here.

## 3. Phased implementation

### Stage 0 — capability + coverage probe
- Verify agentic-account crypto onboarding (`get_crypto_account_onboarding_info`) — live call,
  read-only, no order.
- Verify RH crypto quote/candle data coverage for a real candidate universe (BTC, ETH, and
  whichever others RH lists) sufficient for technical scoring.
- Verify a sentiment source exists for crypto (Alpha Vantage news-sentiment coverage check).
- Stop cheaply if onboarding or data coverage fails.

### Stage 1 — instrument family + session convention (no trading)
- Add `crypto` to `InstrumentFamily`, `scoreMode: "blocked"`.
- Build `lib/data/crypto-session.ts` and wire it into any purge/embargo/fold code that will ever
  see a crypto row — additive, existing `us`/`india` paths unchanged.
- No scores, no candidates, no trades.

### Stage 2 — technical+sentiment+macro composite, measure-only
- `scoreMode: "measure_only"`, matching the existing family-evidence pipeline
  (`instrument_family_evidence`) — nothing trades yet, but the composite's own predictive power
  gets measured honestly before it's trusted.

### Stage 3 — paper trading
- `scoreMode: "legacy_v1"` for crypto only after Stage 2's evidence clears the same floors every
  other dimension in this codebase is held to (`MIN_PREDICTIVE_DATES`, etc.).
- New paper pool (§2.5). PaperTrader/PositionMonitor gain a crypto-aware path — reusing the
  existing per-market pattern, scoped by instrument family instead of market.
- Genome stays shared with equities (§2.4).

### Stage 4 — live (separate future decision)
- Not proposed here. Would need its own decision record and its own pass through the L3/L4
  autonomy ladder exactly like equities did, after real paper history exists.

## 4. Acceptance criteria

1. No `market` CHECK constraint changes anywhere — crypto is `market='us'`, a new
   `InstrumentFamily`, never a new market value.
2. Crypto rows never enter a US-equity purge/embargo/fold calculation through the equity session
   functions — mutation test: routing a crypto row through `America/New_York`-based session logic
   must fail a detector.
3. Crypto's paper NAV never sums into the US equity paper pool's NAV.
4. `scoreMode` never jumps a stage — `blocked → measure_only → legacy_v1` in order, each gated on
   the evidence the corresponding stage specifies.
5. No crypto order of any kind (paper or live) exists in Stage 0-2 code.
6. Live crypto trading requires its own separately-approved decision — this document authorizes
   paper only.

## 5. Unresolved decisions requiring Vaibhav's approval

1. Approve Stage 0-3 (paper only) — or a narrower subset.
2. Which coins/candidates (RH's crypto list is not large; needs Stage 0's own inventory).
3. New paper pool starting balance and currency (USD, but how much — separate from the $10k US
   equity pool per §2.5).
4. Whether the `CRYPTO_SESSION_CUTOFF_UTC` convention (§2.2) is the right call, or whether a
   different aggregation convention is preferred.
