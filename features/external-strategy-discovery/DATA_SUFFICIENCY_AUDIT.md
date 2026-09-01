# Data sufficiency audit — Stage 0R step 4

Measured against production `price_cache`, 2026-09-01. **Evidence only; nothing
acquired, nothing changed.**

This is the gate the architecture placed before naming any strategy. The answer
is clear and it blocks the trial family as sketched.

## The corpus

| metric | value |
|---|---:|
| distinct symbols | **283** |
| total daily bars | **72,049** |
| earliest bar (any symbol) | 2021-07-26 |
| latest bar | 2026-09-01 |

Distribution of history depth:

| sessions held | symbols |
|---|---:|
| >= 1000 | **2** |
| 500 - 999 | **0** |
| 250 - 499 | 242 |
| < 250 | 39 |

**The corpus is bimodal with nothing in the middle.** Two ETFs carry five years;
everything else carries roughly one year.

The only symbols with deep history:

| symbol | sessions | from | to |
|---|---:|---|---|
| VOO | **1,280** | 2021-07-26 | 2026-08-28 |
| VXUS | **1,255** | 2021-07-26 | 2026-07-24 |

## The proposed family, measured

After a 200-session warm-up (what a 200-day MA requires before its first
decision):

| symbol | sessions | usable decisions | verdict |
|---|---:|---:|---|
| VOO | 1,280 | **1,080** | ample |
| XLK | 306 | 106 | thin |
| XLF | 306 | 106 | thin |
| SPY | 280 | **80** | thin |
| QQQ | 280 | 80 | thin |
| IWM | 280 | 80 | thin |
| GLD | 280 | 80 | thin |
| TLT | 35 | **0** | **unusable** |
| IEF | 35 | **0** | **unusable** |

This confirms the review's figures exactly: ~80 usable SPY sessions, 35 total for
TLT/IEF.

## Verdict

**The six-strategy family cannot be replayed on held data.**

- The monthly asset rotation and any bond-trend rule are **impossible** — TLT and
  IEF have 35 bars each and zero usable decisions after warm-up.
- SPY 200-day MA yields **80 decision sessions**. At a 20-session holding
  horizon that is 4 effective observations against a floor of 12. A replay would
  produce a number, and the number would not be evidence.
- Only VOO and VXUS support a long-warm-up rule today.

## The finding nobody had

**VOO carries 1,080 usable decisions — 13.5x SPY — for the same economic
exposure.** Both track the S&P 500. The trial family was specified on SPY
because that is what the source articles use, not because it is what we hold.

Two consequences:

1. **Respecifying index-level rules on VOO instead of SPY converts an
   unanswerable replay into an answerable one at zero acquisition cost.** The
   200-day MA, Turn of the Month and Turnaround Tuesday are all index-exposure
   rules; none requires SPY specifically.
2. **This is a specification change, so it is a new trial.** Under the ledger
   contract, "200-day MA on VOO" and "200-day MA on SPY" fingerprint apart and
   each increments the family count. It is not a free substitution.

## Recommended next move

**Do not acquire history yet.** Two cheaper steps first:

1. **Respecify the index-exposure slots on VOO/VXUS** and re-run this audit. If
   the family's entry and exposure rules become answerable on held data, the
   acquisition question shrinks to the bond/rotation slot alone.
2. **Prove the seam on VOO before buying anything.** Step 3 built the compiler,
   NAV marker and negative controls but has never run them end to end on real
   bars. VOO's 1,080 sessions are enough to execute that proof today, including
   the negative controls. If the seam misprices a control on real data, no amount
   of purchased history helps.

Acquisition becomes the right call only after the seam is proven and the
remaining gaps are known precisely — which slots, which symbols, how many years.

## What this does NOT establish

- Nothing about whether any strategy works. This is a count of bars.
- Nothing about data QUALITY. `price_cache` has no immutable provider, basis or
  version provenance, so adjusted history can be restated after a split or
  dividend and a "sealed" replay can silently change. That remains an open
  blocker recorded in the architecture, and depth does not fix it.
- Nothing about India, which stays blocked pending its own PIT membership,
  corporate-action and benchmark contracts.
