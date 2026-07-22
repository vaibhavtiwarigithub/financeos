# Candidate Intake: tradingviewapi.com MCP

**Status:** UNVERIFIED THIRD-PARTY CANDIDATE — DO NOT CONNECT
**Reviewed:** 2026-07-21
**Decision:** sandboxed, non-influencing probe only after owner approval

## Identity Correction

An MCP service exists at `https://www.tradingviewapi.com/mcp/`. This corrects the
earlier over-broad statement that no "TradingView MCP" existed. The reviewed
evidence does **not** establish that this service is operated by TradingView Inc.
It uses a separate RapidAPI subscription/key, a `tradingview-data1.p.rapidapi.com`
API host, and a `mcp.tradingviewapi.com` JWT. A paid TradingView Pro subscription
does not supply those credentials or quotas.

Official TradingView sources separately state that ordinary users do not receive
a market-data/indicator API and restrict automated/non-display use of data made
available through TradingView. Therefore Kairos must not treat this candidate as
an entitlement inherited from the owner's TradingView account.

## Claimed Capability (Not Yet Independently Proven)

The candidate advertises search, metadata, single/batch quotes, OHLCV, technical
analysis, news/detail, calendars, and leaderboards across global exchanges. Its
published free tier is 150 requests/month; production MCP tokens are described on
higher RapidAPI tiers. These are vendor claims, not Kairos validation evidence.

## Required Probe Before Any Admission

1. Establish legal entity, data-provider rights, commercial/non-display terms,
   retention/redistribution rights, privacy policy, and incident contact.
2. Use a dedicated RapidAPI test key with the smallest quota and no broker,
   Supabase, Vercel, TradingView, or user credentials.
3. Enumerate the live MCP tool schema and capture fixture responses for a bounded
   US/India symbol set. Reject prompt text or executable content in responses.
4. Compare timestamps, adjustment basis, currency, exchange identity, and values
   against existing canonical sources. Missing/delayed data must remain explicit.
5. Keep results in external research shadow only: no scoring, eligibility,
   ResearchAgent, Router policy, risk posture, orders, or provider fallback.
6. Admit an intent only through the existing EvidenceEnvelope/provider-policy
   process after provenance, quota, reliability, licensing, and parity review.

## Current Recommendation

Do not install or pay now. The free 150-request tier is sufficient for a legal and
technical probe but not for Kairos's daily multi-symbol pipelines. Its most useful
potential value is one bounded comparison of global/India coverage and TA
semantics, not replacing validated providers or bypassing API quotas.

## Sources

- Candidate MCP: https://www.tradingviewapi.com/mcp/
- Candidate pricing: https://www.tradingviewapi.com/pricing/
- Official TradingView API answer:
  https://www.tradingview.com/support/solutions/43000474413-i-need-access-to-your-api-in-order-to-get-data-or-indicator-values/
- Official TradingView terms: https://www.tradingview.com/policies/
