# Event-Aware Fundamentals and Exchange-Listed ADRs

Status: Approved for implementation by owner on 2026-07-31

## Decision

Kairos will reuse company-reported facts across agents through one event-aware
freshness policy and will treat reviewed US exchange-listed ADRs as a distinct
instrument kind. ADRs may be researched and paper-traded in the US/USD book.
Live compatibility uses every existing pause, kill-switch, account, portfolio,
broker-review, and order-acknowledgement gate; this feature does not enable live
trading or assert that a broker supports a symbol.

## Why

ResearchAgent and ThemeScout currently share same-day provider cache rows, but
the active Finnhub metric/profile path normally polls again the next UTC day.
Reported margins and revenue do not require daily polling outside an event
window, while valuation and earnings dates do. Treating the whole provider
response as one freshness class either wastes calls or serves stale valuation.

ADRs also cannot be treated as ordinary domestic issuers. Foreign private
issuers generally do not provide Section 16 Form 4 evidence, and some providers
resolve an ADR symbol to the foreign underlying. A live 2026-07-31 probe for
SKHY returned Korean-underlying EPS from Finnhub but USD ADS-basis fields from
Yahoo. Mixing those units can corrupt valuation and comparability.

## Verified SK hynix Identity

- Current US instrument: `SKHY`, Nasdaq Global Select Market.
- Temporary when-issued symbol: `SKHYV`, retired after 2026-07-10.
- Each SKHY ADS represents one-tenth of a KRX `000660` common share.
- Legacy `HXSCL` is a restricted/limited OTC GDR and is not a substitute.
- Sources: Nasdaq Trader Alert 2026-37, SEC Form F-1/424(b)(4), Citi DR record.

Only `SKHY` is added to the reviewed ADR registry. OTC/foreign-exchange symbols
remain excluded from automatic discovery and live execution.

## Freshness Contract

One batch lookup of `earnings_calendar` annotates symbols before provider work:

| State | Reported-fact freshness |
|---|---:|
| Report date within the prior 3 days or next 14 days | 1 day |
| No near event, but a calendar record exists | 7 days |
| Earnings date unknown | 7 days, fail conservatively |

Issuer profile/classification uses 30 days. Price bars remain completed-session
daily data. Earnings dates remain daily inside the existing calendar path.
Because the legacy Finnhub metric response mixes reported and valuation fields,
its maximum freshness is seven days rather than Router's future 14-day reported
contract. The Router may later split `fundamentals.reported` (14 days) from
`fundamentals.valuation` (3 days) after parity approval.

An event-window refresh does not change scores by itself. It only makes the next
normal scoring pass fetch current facts. Provider failures continue to return
bounded cached data or unavailable; they never fabricate a fresh observation.

## Agent Boundaries

- ResearchAgent is the only authoritative scorer and receives the annotated TTL.
- ThemeScout validates ticker existence with a quote/instrument lookup, not a
  complete fundamental fetch. Its candidates are still scored later by ResearchAgent.
- Prewarm uses the same annotated symbol entries and cache rules.
- Router shadow collection remains separate and cannot affect scores or orders.
- Learner records `asset_class='adr'`, preventing ADR evidence from being silently
  pooled as a domestic issuer when segment diagnostics become available.

## ADR Scoring Contract

- Market/currency: US / USD, never cross-summed with the India/INR book.
- Technical, sentiment, US macro, options, and analyst applicability match a
  US-listed equity when the source supports the symbol.
- Fundamental source order: ADS-aware Yahoo first, then only compatible fallbacks.
- Insider/Form 4: structurally not applicable and excluded from weight
  renormalization, not assigned a neutral score.
- New ADRs require a reviewed registry entry or a future verified instrument
  classifier. Symbol suffix guessing is forbidden.

## Trading Contract

- PaperTrader accepts `adr` as a US asset class and uses USD/fractional paper sizing.
- Live fund-concentration classification treats `adr` as an equity, not an ETF.
- The Robinhood MCP `review_equity_order` remains mandatory before placement.
- A broker rejection or unsupported symbol fails closed. No fallback to an OTC
  symbol, foreign listing, or alternate broker occurs automatically.
- OTC instruments require a separate design: whole-share sizing, limit-day-only
  orders, liquidity/spread gates, market-tier and disclosure checks, and explicit
  broker support. They are out of scope here.

## Acceptance Criteria

1. `SKHY` is classified as `adr`, enters US research from the watchlist, and
   persists `asset_class='adr'`.
2. SKHY fundamentals prefer Yahoo ADS-basis values; Finnhub's Korean-underlying
   profile cannot win the ADR chain.
3. ADR insider evidence is inapplicable and consumes no insider provider call.
4. An eligible long SKHY signal can enter the paper selection/fill path without
   a special-case rejection.
5. Live classification recognizes ADR as non-fund equity but every existing live
   and broker review gate remains in force.
6. ThemeScout ticker validation consumes no full-fundamental call.
7. Near-earnings symbols use one-day reported freshness; ordinary symbols use
   seven days; profiles use thirty days.
8. Tests, architecture chapters, system map, and research diagram agree.

## Reversal

Remove SKHY from the reviewed registry and restore one-day freshness constants.
No trade, historical signal, or immutable evidence row is rewritten.
