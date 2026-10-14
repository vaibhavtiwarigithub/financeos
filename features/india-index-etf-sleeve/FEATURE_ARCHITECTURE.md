# Feature Architecture: India Index-ETF Sleeve

## Status
**DRAFT. Not implemented.** Owner said "Approved, implement the index-ETF sleeve proposal" on 2026-10-13, but no concrete proposal existed (it had only been offered). This document is that proposal. Three options are laid out; the one to build needs an explicit choice because it changes how real paper capital is allocated.

## Why it was asked
On 2026-10-13 NIFTY rose 1.60% while the India paper book rose 0.74%. An index-ETF sleeve (NIFTYBEES.NS) would make the book track the index more closely.

## Evidence (production data, 2026-07-06 to 2026-10-13, 66 daily returns)
| Metric | Value |
|---|---|
| India paper NAV | **+3.22%** |
| NIFTY 50 | **-6.99%** (a falling market) |
| Portfolio beta to NIFTY | 0.49 (corr 0.55, R2 0.30) |
| Up-day capture | portfolio +0.34% vs index +0.58% (59%) over 26 up days |
| Down-day capture | portfolio -0.14% vs index -0.55% (26%) over 40 down days |

Counterfactual: a daily-rebalanced sleeve of weight w in the index (perfect tracking, no fees or tracking error) blended with the actual book:

| Index weight | Total return | Annualized vol | Max drawdown |
|---|---|---|---|
| 0% (book) | +3.22% | 10.6% | -4.32% |
| 10% | +2.16% | 10.2% | -4.28% |
| 20% | +1.11% | 9.9% | -4.32% |
| 30% | +0.07% | 9.8% | -4.43% |
| 50% | -1.98% | 9.8% | -4.89% |
| 100% | -6.99% | 11.7% | -10.26% |

**Reading it honestly.** In this window every dollar moved into the index cost return and barely changed drawdown, because the book's low beta already protected it in a -7% market. This is one regime and 66 days: in a rising market the sign flips, and the book's apparent edge may be partly the thin-name fills fixed by the liquidity floor (see `features/india-paper-liquidity-floor`). So the sleeve is not "free diversification": it is a bet that tracking the index matters more than the book's own alpha. It reduces tracking error against NIFTY, not risk.

## Liquidity of the candidate instruments (Yahoo, 1 month, 2026-10-13)
NIFTYBEES.NS ~INR 204 crore/day, ITBEES.NS ~33, BANKBEES.NS ~34, JUNIORBEES.NS ~30. All pass the new INR 1 crore floor by 30x or more. None of them is currently in the India universe (zero signals, zero profiles).

## Options
**A. Idle-cash only.** Buy NIFTYBEES with cash above the 5% soft target. Problem: India cash is ~0% by design (8 names x ~12%), so the sleeve would almost never hold anything. Not useful.

**B. Live paper sleeve (carve-out).** Reuse the shipped-off `strategy_sleeves` / `allocate()` machinery (feature `asset-allocation`): add an `index_etf` sleeve for India, target 20% (band 10-30), instrument NIFTYBEES.NS, rebalance weekly with a 5% deadband, no stop (index ETF), role `index_sleeve` excluded from alpha learning, exempt from the 8-name cap, funded by lowering the equity target (about 6 alpha names at ~12% = 72%, sleeve 20%, cash ~8%). Costs: fewer alpha slots, return given up in a falling market (table above: roughly -2.1 points over this window at 20%). Needs: sleeve row, paper-trade sizing wiring (the asset-allocation follow-up #1 that was never built), a weekly rebalancer, position-monitor handling, ledger/NAV checks, learning exclusions, tests. Money-path work, several files.

**C. Shadow sleeve first (recommended).** Record, daily and append-only, the NAV the book WOULD have had with a 10/20/30% NIFTYBEES sleeve (no orders, no capital moved), plus tracking error and up/down capture vs NIFTY, and show it on the Learning page. Measure-only, one cron and one table, reuses the macro-series `nifty50_close` and the ETF bars. Gives a forward, out-of-sample answer across a rising AND falling market before any capital is carved out. Revisit after 8-12 weeks, or sooner if a clear regime change gives enough signal.

## Recommendation
C, then B only if the forward comparison shows the sleeve improves risk-adjusted return, not just tracking. The only evidence available today argues against B, and B changes how capital is allocated, which is the kind of change this project's rules ask to be evidence-gated.

## Non-goals
No change to US, to alpha entries or exits, to stops, or to the liquidity floor. No leverage. No live/broker path.

## Approval
Pending an explicit choice of A / B / C (B needs the sleeve size, default 20%).
