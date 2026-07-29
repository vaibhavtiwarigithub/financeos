# Feature Architecture: Earnings-Aware Risk (options-implied move)

## Status

Architecture status: Draft
Architecture approved: No
Approved scope: None
Approved date: None
Implementation allowed: No

## Feature Purpose

Stop the paper/live book from entering and holding positions blind through
earnings prints, by using the one thing the options market prices well: the
**expected magnitude** of the next move.

## The distinction this feature is built on

**Options price magnitude well and direction badly.** A straddle says "±7% is
expected"; it deliberately says nothing about which way, because the market
maker setting that price is delta-neutral.

Kairos is long-only, directional, 2–20 market-day swing. So options are close to
worthless as a directional alpha input and genuinely valuable as a **risk**
input. This feature takes only the second interpretation.

## NON-GOAL — options as a sixth scoring dimension

Explicitly out of scope, and not merely deferred.

The 2026-07-28 OOS work established that a single factor cannot be validated at
this scale: realized IC sigma ~0.26, effective breadth ~17 names, ~180 as-of
dates needed against ~25 available (`features/walk-forward-ic-folds` Annex K/L).
Adding options to the weighted score would introduce a **sixth unvalidatable
alpha claim**, with less supporting evidence than the five already there.

An implied-move risk estimate makes **no directional prediction**, so it needs no
IC validation. That is why it is buildable now and a scoring dimension is not.

The dead `buildStockPrompt` instruction — *"unusual call activity boosts
conviction for longs"* — is the weakest available use of options data: visible
flow cannot distinguish opening from closing, buying from selling, or a naked
bet from a delta-hedged leg. It should be deleted, not revived.

## Current Behavior

| Piece | State |
|---|---|
| `lib/options-signal.ts` | Fetches Yahoo chain; computes put/call ratio, unusual contracts, IV percentile, nearest expiry, ATM contract |
| `fetchOptionsSignal()` callers | **Only** `app/api/options/signal/route.ts` — on-demand, never in the scoring or trading path |
| `buildStockPrompt` / `buildSynthesisPrompt` | **Dead code — zero call sites.** The options prompt block never renders |
| `"options"` in `Dimension` union + `applicableDimensions()` | Declared, added to the set, **never read**. Verified inert: no `.has("options")`, no `.size`, no enumeration, no field maps to it, not in the weighted mask |
| `lib/data/earnings.ts` | `fetchDaysToEarnings(symbol, india, preferredDate)` already exists |
| `lib/data/earnings-pit.ts` | PIT vintage capture already exists |
| PaperTrader entry | **No earnings awareness.** A 2–20 day hold spans an earnings cycle, so roughly 1 position in 6 holds through a print blind |

## Proposed Behavior

Two components. Component A is useful alone; B sharpens it.

### A. Earnings-proximity gate at entry

At paper/live entry, resolve days-to-earnings for the candidate. If a print
falls inside the intended holding horizon, the entry is **gated by policy**, not
silently taken.

Policy options for owner decision (see Open Questions):
- `block` — no new long when earnings fall within the horizon
- `size_down` — permitted at reduced size
- `annotate_only` — recorded on the proposal, no behavioural change (shadow mode)

Fails **open** on unavailable earnings data — an unknown date must not silently
block trading, but must be recorded as unknown rather than treated as "no
earnings".

### B. Options-implied move

Extend `lib/options-signal.ts` with an ATM-straddle implied move for the expiry
that brackets the earnings date:

```
impliedMovePct ≈ (ATM call mid + ATM put mid) / spot
```

Surfaced as risk context, and compared against the position's stop distance. The
decision-grade output is the comparison, not the number:

> *"stop is 7%, implied move is 9% — the stop is inside the noise band"*

## System Flow

1. Candidate reaches entry with a resolved horizon.
2. `fetchDaysToEarnings()` → days to next print (or unknown).
3. If a print falls inside the horizon → fetch chain, compute implied move.
4. Compare implied move to the proposal's stop distance.
5. Apply the approved policy; record the reason on the proposal either way.

## Module Inventory

| Module | Change |
|---|---|
| `lib/options-signal.ts` | Add `impliedMove(symbol, targetDate)`; keep existing exports untouched |
| `lib/data/earnings.ts` | Reuse `fetchDaysToEarnings` as-is |
| `lib/trading/` entry policy | New pure `earningsRiskVerdict()` — inputs in, verdict out, no fetching |
| `app/api/agents/paper-trade/route.ts` | Call the verdict at the existing entry choke point |
| `trade_proposals` | Persist verdict + implied move + stop-vs-move comparison |
| `docs/arch/03-agents.md`, `08-risk-and-safety.md` | Gate documented as a risk control |
| `public/agent-diagrams/system-map.json` | New edge into the trading path |

## Data Architecture

- Required: earnings date (exists), options chain (exists).
- No new provider, no new key. Yahoo chain is keyless; the earnings path already
  has its own sourcing.
- Cache the chain per (symbol, day) — it is only consulted near a print, so
  volume is low.
- Validation: an implied move outside a sane band (say 0.5%–50%) is treated as
  unavailable rather than trusted.

## Files / Behavior That Must NOT Change

- The five weighted scoring dimensions and `analyst_score`. This feature does
  **not** touch scoring.
- `strategy_policies` / promotion. Unrelated and still dormant.
- Long-only enforcement, kill switches, notional caps.
- India: no options source exists. India must return `unavailable` and fail
  open, never borrow US options data.

## Risks

- **Earnings dates are unreliable.** Providers disagree and dates move. A gate
  keyed to a wrong date blocks or permits wrongly — hence fail-open plus an
  explicit `unknown` state.
- **Scope creep into alpha.** Once implied move exists, the temptation to feed
  it into scoring is obvious. The non-goal above is the guard.
- **`block` reduces trade count.** With US at 8 closed trades, further
  suppressing entries slows the already-thin evidence accumulation. This argues
  for `annotate_only` first.
- **FinancialDatasets is out of credit** (observed 2026-07-29) — confirm which
  provider actually backs `fetchDaysToEarnings` before relying on it.

## Open Questions For Owner

1. **Policy:** `block`, `size_down`, or `annotate_only` to start? Recommend
   `annotate_only` — it collects evidence on how often the case arises without
   suppressing an already-thin trade record.
2. **Horizon test:** gate on the mandate's `max_hold_days`, or on the specific
   proposal's resolved horizon?
3. **Existing positions:** does PositionMonitor act on an approaching print for
   an open position, or is this entry-only in v1? (Recommend entry-only.)
4. **Delete the dead code** — `buildStockPrompt`, `buildSynthesisPrompt`, and
   `"options"` from the `Dimension` union — in this change or separately?

## Recommendation

Approve **A in `annotate_only` mode + B**, entry-only, India returning
`unavailable`. That produces real decision-grade context and a measurable record
of how often earnings risk actually bites, without changing what gets traded
until there is evidence to justify it.

Revisit `block` / `size_down` once the annotation record shows the frequency and
the stop-vs-implied-move relationship on real candidates.
