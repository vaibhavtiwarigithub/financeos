# Broker capability expansion — prioritized plan

Date: 2026-09-04. Author: Claude (Sonnet 5), Architect role.
Answers: re-verification of the 2026-09-04 Robinhood/Coin/crypto/genome findings, plus a
priority-ranked fix plan with research per item. Architecture only — see
`features/robinhood-crypto/FEATURE_ARCHITECTURE.md` for the one item that is actually buildable.

## 0. Re-verification — did I miss anything on Coin?

**No new commit exists beyond `b4dec802`.** Checked `git log` across the last 7 days for anything
touching Coin: only `b4dec802` ("feat: add read-only Zerodha Coin portfolio sleeve") does. Its own
commit message is explicit: *"No purchase, redemption, or SIP capability was added."* The request
made a week ago and the one built match — read-only visibility, not trading. What's different this
turn is Vaibhav asking for trading now, which is new scope, not something missed earlier.

**What I did miss last turn**: I answered the Robinhood/crypto/Coin question without checking
whether Zerodha's own API can even place a Coin order. It can't (§1). I also didn't mention that
Kairos already has a full multi-layer live-trading gate ladder (`lib/autonomy.ts`,
`AUTONOMOUS_LIVE_ENABLED` + DB `autonomy_level` + lease + typed confirmation + a 9-gate execution
kernel) built and battle-tested for equities across many 2026-07 WORK_LOG entries — that's the
existing pattern any new order-capable asset class should reuse, not reinvent.

## 1. Zerodha Coin trading — BLOCKED by Zerodha's own API, not a priority decision

Verified against Kite Connect's own documentation
(`https://kite.trade/docs/connect/v3/mutual-funds/`), fetched 2026-09-04:

> *"The mutual fund APIs allow managing SIPs of mutual funds listed on Zerodha's Coin platform,
> where successful purchases are delivered to the buyer's DEMAT account. **Order placement can't
> be done, as order placement needs payment from the user's bank account.**"*

Every documented Coin endpoint is `GET`-only: `/mf/orders`, `/mf/orders/:order_id`, `/mf/sips/`,
`/mf/holdings`, `/mf/instruments`. There is no POST/create endpoint for a purchase, a redemption,
or a SIP anywhere in the mutual-fund API surface. This is not a scope choice Kairos made — Zerodha
does not expose one. A mutual fund purchase requires a bank-account payment authorization (UPI
mandate or net-banking) that only works through Zerodha's own Coin app/website session, which the
Kite Connect API deliberately does not proxy.

**The one real mechanism**: Kite Connect's "Publisher" feature — an embeddable buy/sell link that
redirects a **human** to Zerodha's own checkout page to complete payment themselves. This is not
autonomous or agentic in any sense; it's a deep-link, equivalent to Kairos showing you a button
that opens Zerodha's own app to the right fund. It could be built as a convenience (one click from
a Kairos page instead of searching in Coin), but it does not give Kairos anything resembling order
placement, sizing, or execution control, and it doesn't fit anywhere in the existing paper→shadow→
live governance ladder because there's no Kairos-controlled step to gate.

**Recommendation: do not build Coin order placement. It's not buildable against the real API.**
If a one-click Publisher deep-link to Zerodha's own checkout is still wanted as a pure UI
convenience, that's a small, separate, low-priority ask — not "trading," and it carries no
scoring/sizing/genome implications. Ask if you still want that; it's not on this plan otherwise.

## 2. Robinhood crypto trading — buildable, architecture drafted, reopens Decision 2

**Confirmed real, unlike Coin.** Robinhood's MCP surface has genuine write tools:
`place_crypto_order`, `preview_crypto_order`, `cancel_crypto_order`, plus reads
(`get_crypto_positions`, `get_crypto_orders`, `get_crypto_quotes`, `get_currency_pairs`,
`get_crypto_account_onboarding_info`). None of Kairos's code calls any of them today — confirmed
by grep, zero cryptocurrency-trading references anywhere in `lib/` or `app/`.

**This was excluded by explicit product decision, not oversight.** `PROJECT_DECISIONS.md`
Decision 2 (2026-06-27): *"Use long-only 2-20 market-day swing strategies over Robinhood-supported
US equities and ETFs... Shorts, options, leverage, **crypto**, intraday trading, and non-agentic
accounts are excluded."* Building crypto trading means reopening this decision, not silently
overriding it — done explicitly below as a new decision that amends Decision 2's scope rather than
rewriting history, consistent with how this codebase treats every other locked decision.

**Full architecture**: `features/robinhood-crypto/FEATURE_ARCHITECTURE.md` (this session). Summary
of the two hardest problems it has to solve, found by re-reading the actual codebase rather than
assumed:

1. **Crypto trades 24/7; virtually every timing primitive in this codebase assumes a market
   session.** Grepped: 18 files hardcode `America/New_York`/`Asia/Kolkata`; 11 files build purge/
   embargo/session logic off `expectedNewestSession`-style trading-day calendars
   (`walkForwardFolds`'s own session array, the quote cross-check's `exchangeSessionDate`, the
   earnings-repricing barrier's `marketDay()`). None of these have a "crypto session" concept
   because there isn't one — a naive port would either silently treat every UTC day as one session
   (wrong — crypto never closes, so "the close" is arbitrary) or crash on a 24/7 feed. The
   architecture proposes treating crypto as its own THIRD `market` value with its own explicit
   session convention (a fixed daily UTC cutoff, documented as a convention not a real market
   close) rather than bending the US/India session model to fit it.
2. **No fundamental dimension applies.** Crypto has no P/E, no earnings, no analyst coverage, no
   insider transactions — four of the five scoring dimensions Kairos already computes are
   structurally inapplicable, the same situation ETFs are already in (`scoreFundamentals`'s
   neutral-baseline branch, `ETF_SCORE_CAP`). The architecture proposes a crypto composite of
   technical + sentiment + macro only, following that existing precedent rather than inventing a
   new scoring shape.

## 3. Unused Robinhood read tools — low priority, no urgency, no risk

From the prior turn's audit: `get_equity_fundamentals`, `get_equity_technical_indicators`,
`get_sec_filing*`, `get_realized_pnl`/`get_pnl_trade_history`, watchlist and scanner tools are on
RH's MCP surface but not in Kairos's 6-tool research allowlist
(`ROBINHOOD_RESEARCH_READ_TOOLS`, `lib/robinhood-mcp.ts:412`).

**Priority: low.** The one with real potential value is fundamentals/technicals as a second data
source, since Alpha Vantage's shared 25/day budget is already the tightest constraint found this
week (`docs/audits/2026-09-03-earnings-expectations-peer-delta-codex-brief.md` §4.4/§3.1). Adding
RH fundamentals to the allowlist is a small, safe, read-only change — but it's not blocking
anything, and I'd rather it wait until the AV-budget question from that brief actually gets
answered, so the two aren't solved twice by two different agents in parallel. Not scheduled here;
flagged for whenever that budget question resolves.

## 4. Per-asset-class genome — deferred, sequencing unchanged from last turn

Still the right call from last turn, now sharper: crypto's own architecture (§2) already needs its
own scoring composite and its own session convention — that's asset-class differentiation at the
**data and scoring** layer, which is necessary regardless. Genome (horizon/exit/sizing) staying
shared for now is a separate, smaller simplification, not a blocker to shipping crypto paper
trading. Revisit genome-per-family once (a) crypto has real paper history and (b)
`features/shadow-population/FEATURE_ARCHITECTURE.md`'s P0/P1 has proven itself on at least one
real shadow — both preconditions unmet today. Added a forward-reference note in that document
(§0b) so this isn't orphaned.

## 5. Priority order

| # | Item | Status | Effort |
|---|---|---|---|
| 1 | Robinhood crypto — paper trading only, own scoring composite, own session model | **Architecture ready, needs approval** | Large (new market value, new scoring path, new genome bounds, new UI) |
| 2 | Zerodha Coin trading | **Blocked — not buildable against Zerodha's real API** | N/A |
| 3 | RH crypto → live (owner-approved, L3 manual) | Deferred until paper history exists and Decision 2's amendment is exercised in practice | Medium, after #1 |
| 4 | RH unused read tools (fundamentals/technicals) | Backlog, low priority, no urgency | Small |
| 5 | Per-asset-class genome | Deferred — depends on #1's history and shadow-population P1 | Large, not now |

## 6. What still needs Vaibhav's decision before Sonnet 4.6 writes code

1. Approve `features/robinhood-crypto/FEATURE_ARCHITECTURE.md` (paper-only scope) — see that
   document's own §9 for the specific open questions (which coins, position-cap philosophy given
   24/7 volatility, whether the existing $10k US paper pool absorbs crypto or gets its own pool).
2. Confirm Decision 2's crypto exclusion should be amended for PAPER only, live staying a fully
   separate future decision exactly like equities' own L3/L4 ladder already requires.
3. Decide whether the Kite Publisher one-click deep-link (§1) is wanted at all, given it's not
   trading and wasn't really what was asked for.
4. RH crypto's actual onboarding/entitlement status on the agentic account
   (`get_crypto_account_onboarding_info`) is **unverified** — this session could not make a live
   RH MCP call (no interactive OAuth session available here). This is Stage 0 of the crypto
   architecture, not something to assume either way.
