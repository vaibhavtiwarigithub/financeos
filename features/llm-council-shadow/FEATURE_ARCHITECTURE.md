# LLM Council — Shadow Annotation

**Status:** DEFERRED by owner decision, 2026-08-20. Not approved, not implemented.
**Revive when:** the US equity book clears its own evidence floor (`n >= 60` closed trades with h10 labels AND `nEffective = n/10 >= 12` per market). Until the strategy that already exists is measurable, a second lane multiplies the measurement burden rather than diversifying it.
**Date:** 2026-08-20
**Scope:** measure whether a multi-model review would have improved decisions. Writes no direction, no size, no order.

## The question this answers

Not "should an LLM help decide" — that is unanswerable today. The answerable
question is:

> **When the council disagrees with the deterministic scorer, who turns out to be right?**

That has a real answer, from data we already collect, in about three months. Until
it is answered, wiring model opinion into the money path is a guess wearing a
number.

## Why this shape and not the obvious one

The obvious design — several models score a stock, take the median, gate on it —
does not remove non-determinism. It **moves** it. The median of three stochastic
estimates is a stochastic estimate with a deterministic wrapper. `PROJECT_DECISIONS`
already closed this door on 2026-07-15: an LLM `direction` on a held name became an
executable exit and taught the learner from LLM-created outcomes. The fix made
direction deterministic (`lib/signal-direction.ts`) and demoted the model's opinion
to `research_packets.raw_data._original_direction` — advisory, stored, read by
nothing.

**This proposal is that same pattern, applied deliberately and measured.**

## Where an LLM genuinely adds something

Worth being precise, because "LLMs are smart" is not an argument.

| Dimension | Current input | Can a model add? |
|---|---|---|
| Fundamental | P/E, FCF yield, insider buying — real numbers | **No.** Arithmetic on fetched fields. A model would only paraphrase. |
| Technical | RSI/EMA/ADX/ATR — deterministic | **No.** |
| Macro | FRED regime, 3/8 indicators | Marginal. |
| **Sentiment** | StockTwits bull/bear %, GDELT tone | **Yes.** These are thin proxies for "what is actually being said". |
| **News / events** | not scored at all | **Yes.** M&A, guidance, litigation, supply shocks live in prose. |

So the council's job is narrow: **read the unstructured evidence the numeric
pipeline cannot, and say whether it contradicts the score.** Not "rate this stock".

## Architecture

### The isolation boundary (load-bearing)

Modelled on the Property invariant and the risk-research display join (invariant
R1). **No council output is read by any scorer, eligibility gate, sizing rule,
order path, exit, promotion gate, or learner.** Enforced by a coupling test in the
style of `tests/risk-research-annotation.test.ts` — which pins R1 and is itself
falsification-tested — not by convention.

### Flow

1. **Runs AFTER** the deterministic score exists, on entry-eligible decisions only.
   It never sees a symbol the scorer has not already judged.
2. **Grounding contract.** The prompt carries ONLY data already fetched this run:
   the frozen `features` blob, the score breakdown, and the fetched news/sentiment
   payloads. Each fact carries its own as-of timestamp. Recalled facts are
   forbidden — the same §1 rule already in the research prompt ("you do not know
   prices, P&L, RSI values; every number must trace to a tool call made in THIS
   run").
3. **N models, independently.** 3 by default from the 7 already wired
   (`lib/llm-keys.ts`: anthropic, deepseek, groq, gemini, grok, openai, glm).
   Independent calls, no shared context — otherwise they are one opinion.
4. **Structured verdict only:** `{ agrees: bool, concern: enum, confidence: 0-1,
   citation: string }`. Free prose is stored but never parsed into a field —
   the `parseStrategyNotes` precedent, where model output can only ever land in
   one string column and that is provable rather than prompt-dependent.
5. **A referee model** sees the deterministic score, the fetched evidence, and the
   N verdicts, and emits one `council_verdict`. It is stored. **It decides nothing.**

### Storage

New table `council_annotations`, append-only, keyed to `observation_id`. A separate
table — not a column on `decision_observations` — so no existing consumer can pick
it up by accident, and so it can be dropped wholesale if the answer is "no".

## Cost — measured, not guessed

Current volume: **145 observations today, 208 distinct symbols over 7 days, 786
entry-eligible decisions in 7 days** ≈ 112/day eligible.

At 3 models + 1 referee = 4 calls per eligible decision ≈ **450 calls/day**. That
is the honest number and it is not small. Mitigations, in order:

- Score **only entry-eligible** decisions (112/day, not 145 × all).
- DeepSeek is already the default everywhere and is cheap; `llm_call_log` shows
  only 3 distinct models used in 30 days, so provider spread is a new cost.
- Cap per run and sample if the cap binds — a sampled measurement still answers
  the IC question, it just answers it slower.

**This is the main argument against building it now.** It is worth stating plainly
rather than burying.

## Predeclared success criterion — set BEFORE any data

Copying the discipline in `aggregateAtrExitEvidence`:

- The unit of analysis is a **disagreement**: council says `agrees=false` on an
  entry-eligible decision.
- Outcome = the existing forward label at h10 (`observation_labels`), so no new
  labelling machinery.
- **Date-clustered** — one decision date is one draw; same-day decisions share a
  market shock.
- Floor: `n >= 60` disagreements AND `nEffective = n / 10 >= 12` before the
  comparison may be cited at all.
- Success = disagreements underperform agreements by a date-clustered `t >= 2`.

### Kill condition, also predeclared

If the floor is met and `|t| < 2`, the lane is **deleted, not tuned**. Written now
so it cannot be relaxed once the data is in.

## Explicitly NOT in scope

No direction. No sizing. No orders. No exits. No promotion input. No change to
`analyst_score`, the mandate, or any gate. Nothing here may be read by the money
path. Cross-model *agreement* is not a green light and is not surfaced as one.

## Operator view

**For:** news and sentiment are genuinely under-served, the models are already
wired, and shadow measurement risks nothing. If disagreements predict
underperformance, that is a real edge and you would have earned it honestly.

**Against, and my recommendation:** the equity book has ~16 clean US sessions, no
demonstrated edge, and sits below the `nEffective >= 12` floor for the strategy
that already exists. Four separate defects shipped into this system on 2026-08-20
alone. The binding constraint is not ideas — it is verification capacity. ~450
LLM calls/day is a real recurring cost for a question that cannot be answered for
three months.

**I would defer** until the equity book clears its own evidence floor. If built
anyway, it must stay a shadow lane with the coupling test and the kill condition,
so it cannot quietly become a sizing input the way the 2026-07-15 exit hole did.

## Open questions for the owner

1. Build now, or defer until the core is measurable? (I recommend defer.)
2. If now: 3 models, or 2 plus a referee to halve the cost?
3. US only, or both markets? India's sentiment coverage is already 0% (GDELT
   sparse), so India is where a model would add most — and where grounding data
   is thinnest, which cuts both ways.
