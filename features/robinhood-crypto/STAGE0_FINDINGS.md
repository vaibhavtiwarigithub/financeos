# RH Crypto — Stage 0 Findings

> Date: 2026-09-04. Author: Claude (Sonnet 5). Status: **COMPLETE — all gates pass.**
> Authorized by: Vaibhav (2026-09-04, verbal approval of `FEATURE_ARCHITECTURE.md`).

## Gate 1: Agentic account onboarding

```
get_crypto_account_onboarding_info → { already_onboarded: true }
```

**PASS.** No signup flow needed. The agentic account already has a crypto sub-account. Signing
provisions crypto accounts for all eligible brokerage accounts under the user — confirmed by
the tool's own guide text. Account `605420660` (the only order-placement account) inherits
crypto capability.

## Gate 2: Coin universe (get_currency_pairs, limit=700)

- **91 total pairs** returned
- **58 tradable and not halted** — limit orders available on all 58
- **33 halted** — all show `halted_regions: ["NY"]`; these cannot trade from NY-routed accounts

### Proposed candidate universe (Tier 1 — liquid large-caps, strong data)

These are the coins with the broadest data availability, highest liquidity, and strongest
technical signal potential for Kairos's RSI/EMA/momentum scoring:

| Symbol | Notes |
|---|---|
| BTC-USD | Deepest liquidity, most sentiment data |
| ETH-USD | Second deepest, AV coverage confirmed |
| SOL-USD | High beta, good technical momentum |
| XRP-USD | High volume on RH |
| AVAX-USD | Layer-1, technical patterns observable |
| LINK-USD | DeFi oracle; correlated with ETH ecosystem |
| DOGE-USD | Optional — high volume, noisy sentiment |

**Vaibhav must confirm final list.** Architecture §5.2 left this open. Recommend starting with
BTC + ETH + SOL as minimum viable set (3 coins = 3 candidates, matches the 3/day screener
ceiling), expanding to 5-7 once the scoring pipeline is proven.

### Halted pairs (excluded from Stage 1)

33 coins halted in NY-region. These may clear over time but are automatically excluded
until tradability reverts. No action needed — the `get_currency_pairs` call is Stage 1's
live filter; halted coins never enter the screener.

## Gate 3: Quote data

```
get_crypto_quotes(["BTC-USD","ETH-USD","SOL-USD","DOGE-USD","ADA-USD","AVAX-USD"])
→ live bid/ask/mark via "Exchange Routing" on all 6
```

**PASS.** Real-time streaming quotes available. `mark_price` is the midpoint (bid+ask/2)
— this is what `computeFillPrice` should use as the reference price before applying
`MODELED_SLIP_FRACTION`. Previous-close is `open_price` (RH's term for midnight UTC boundary).

### Note on candles / OHLCV for technical scoring

`get_crypto_quotes` gives real-time snapshot only (no OHLCV bars). For RSI/EMA/momentum,
Kairos needs historical daily candles. **This is NOT available via Robinhood MCP directly.**

Options for OHLCV:
1. **Alpha Vantage `DIGITAL_CURRENCY_DAILY`** — free tier, same key already in use. Returns
   full OHLCV history for any crypto pair. Confirmed endpoint exists in AV docs; unverified
   against current AV daily-call budget (35-71/day gap still open from earnings-expectations
   architecture). This is the path of least resistance.
2. **CoinGecko free API** — no key required, 30 calls/min, full OHLCV history. Backup option.

**Action required before Stage 2**: verify AV `DIGITAL_CURRENCY_DAILY` returns usable data for
the candidate universe AND count how many AV calls/day the crypto pipeline adds to the existing
budget, then decide if AV is sufficient or CoinGecko is needed.

## Gate 4: Sentiment coverage (AV)

**Not verified live this session** — no AV call made. AV documents `NEWS_SENTIMENT` with
`tickers=CRYPTO:BTC,CRYPTO:ETH` topic support. Assume available; verify in Stage 1 alongside
OHLCV budget check.

## Summary

| Gate | Status | Blocker |
|---|---|---|
| Onboarding | ✅ PASS | — |
| Coin catalog | ✅ PASS | Vaibhav to confirm candidate list |
| Quote data | ✅ PASS | — |
| OHLCV for technical scoring | ⚠️ UNVERIFIED | Check AV DIGITAL_CURRENCY_DAILY budget |
| Sentiment (AV NEWS_SENTIMENT) | ⚠️ ASSUMED | Verify in Stage 1 |

## Go / No-Go

**GO for Stage 1** (add `crypto` to `InstrumentFamily`, build `lib/data/crypto-session.ts`).
OHLCV gap is a Stage 2 prerequisite, not a Stage 1 blocker — Stage 1 adds the family and
session model with no scoring, no trades.

**Stage 2 gate**: AV OHLCV + budget confirmed before any scoring code is written.
