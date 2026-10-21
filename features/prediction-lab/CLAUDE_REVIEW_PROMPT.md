# Paste this prompt into Claude Code

You are reviewing the FinanceOS/Kairos Prediction Lab architecture. This is an
architecture-review task, not implementation authorization. The owner explicitly
wants you to challenge the design and edit the SAME architecture if it is wrong
or can be made simpler/better. Do not merely rubber-stamp Codex's prose.

Repository: `C:\Users\vaibh\OneDrive\Documents\Startup\FinanceOS`.

Primary document: `features/prediction-lab/FEATURE_ARCHITECTURE.md`.
Diagram sources: `features/prediction-lab/diagrams/*.mmd`.
Your durable review output: `features/prediction-lab/CLAUDE_REVIEW_FINDINGS.md`.

## Authority and boundaries

1. Read `AGENTS.md`, `WORK_LOG.md`, `PRD.md`, the knowledge index and the relevant
   existing feature architectures. Follow the reuse protocol. Claim this review
   without overlapping another agent's active work. The owner authorized edits
   to the proposal/diagrams and the work log for this review, not production code.
2. Inspect branch, HEAD, remote and dirty changes first. Do not overwrite,
   stash, discard or switch away from unsaved unrelated work. Reconcile source
   drift since the proposal's baseline commit before trusting its path claims.
3. No production writes, migrations, new trials, inference calls, worker changes,
   model/roster/prompt/settings changes, paper fills, broker actions or live flags.
   Read-only production queries are allowed if authenticated tools are available.
   Never read/print credential-bearing environment files or private worker configs.
4. IMPORTANT: `app/api/agents/strategy-replay/route.ts` GET currently registers
   trials. Do not call it as a read-only verification endpoint. Verify source
   first for every diagnostic route with possible mutations or paid calls.
5. Do not mark a draft built, apply old unapproved strategy migrations, weaken
   ledger constraints, invent positive evidence or hide a missing producer.

## Owner intent to preserve

- Compare every relevant dimension/composite formula, LLM member, council,
  strategy and combination with later outcomes at declared horizons.
- Separate US and India and instrument applicability; reveal missed discovery,
  selection, cash/sizing, rotation, execution and exit failures.
- One understandable comparison home on Learning, with symbol drill-downs and
  honest Upgrade Path progress/portfolio impact when attributable.
- Automate measurement and bounded improvement proposals, not recent-winner
  chasing or unapproved self-modification of trading.
- Reuse existing Kairos code and providers. No replacement platform, new
  backtester, automatic vector database or expensive RL build by default.

## Verification-first review

Independently trace the following owners, their callers, tests, schemas and
scheduled producers. Source and actual production evidence outrank old docs.

- Council `core.ts`, subscription/worker path, cron packet/prompt construction,
  evaluator, availability labels, model identity and call/job usage ledgers.
- Score-variant core/HAC, fixed declarations, frozen miner and Learning panels.
- Dimension diagnostics, technical edge registry and `lib/edges/folds.ts` /
  `oos-experiment.ts` contracts.
- RuleSpec/compiler/NAV/controls, strategy proof route and template contract.
- Simulator, paired portfolio replay, immutable attribution writer and current
  Upgrade Path registry/producer health.
- Versioned benchmark registry, instrument applicability and actual peer/
  earnings-expectation evidence producers.

Verify recent production facts in section 5 if tools permit, recording query
time, market/cohort/model/version and null/insufficient values. Do not treat old
counts as current or query raw tokens. If production is unavailable, explicitly
label that verification NOT PERFORMED and leave no invented results.

## Attack these design claims hardest

A. **Duplication:** do we need the proposed records/modules at all? Can fewer
   compatible existing registries, evaluation tables and projections serve the
   same contract? Explain every genuinely new persistent object and its owner.
B. **Chronology:** common availability, first expected close, early-close/DST
   calendar correctness, missing/interior bars, source vintages, delayed worker
   results, revised fundamentals, memory notes and changing peer memberships.
C. **Statistics:** matched populations, entry versus holding cohorts, missingness,
   session-gap HAC, small/tied cross-sections, paired rather than independent
   effects, multiplicity across models/prompts/markets/horizons/combinations,
   test endpoints, repeated peeking, precision/power and full trial accounting.
   Do not treat sessions/horizon as estimated effective sample size or t>2 as
   sufficient promotion. Challenge a design that cannot become evaluable at the
   actual data/compute budget.
D. **Forecast task:** current 0–100 h10 contract versus multi-horizon evaluation,
   deterministic-score anchoring, partial council roster, independent versus
   debated predictions, confidence versus calibrated probabilities, abstention
   semantics and API/subscription comparison fairness.
E. **Strategies:** existing compiler/simulator correctness and limitations,
   documented RSI semantics, same-close lookahead, multi-symbol cash allocation,
   exact lots/partial exits, capacity, stops/trails, tax/cost conventions and
   whether a prospective policy replay actually matches Kairos's execution path.
   Keep a label horizon distinct from an executable time-stop exit.
F. **Learning:** why reviewing only losses is biased; distinguish evidence from
   plausible post-hoc stories; prevent future memory/lessons leaking into old
   decisions. Is a relational hypothesis ledger enough instead of a vector DB?
G. **Operations/security:** atomic cross-invocation budgets, idempotent dispatch,
   immutability, interrupted pages, schedule/runtime capacity, model identity
   drift, account/market authorization and raw-packet privacy.
H. **Economics and scope:** extra calls versus information gained; no point
   spawning more agents if the input data is unchanged or incomplete. Identify
   what to remove/defer and the smallest useful first release.
I. **Absent issues:** name important problems not covered by these questions.
   The author chose the attack surface; do not let that constrain your review.

## Research requirement

Check primary papers/current official implementations rather than relying on
training memory or framework marketing. Start with the research references in
section 21 and inspect methods/limitations, not just headline returns. Look for
newer contradictory evidence as well. Report what is a historical backtest,
prospective benchmark, live observational result or unverified author claim.
Do not assume an open-source framework guarantees point-in-time integrity or
profitability. Research does not authorize installing packages or copying code.

## Required edits and outputs

1. Edit `features/prediction-lab/FEATURE_ARCHITECTURE.md` IN PLACE to correct
   errors, simplify unnecessary machinery, resolve contradictions and add missing
   implementation contracts/tests. Keep a short review/revision entry recording
   material changes and their rationale. Update diagrams if semantics change.
2. Do not silently replace approved prior project decisions. Distinguish
   implementation facts, proposed policy and unresolved owner decisions. New
   numerical limits/gates must be identified as proposals, not proven optima.
3. Write `CLAUDE_REVIEW_FINDINGS.md` with:
   - Overall verdict: approve for owner implementation decision / revise / defer.
   - Findings ordered P0/P1/P2, each with source path:line or a read-only
     production query/result, impact and the exact architecture correction.
   - An existing-versus-missing matrix; no empty-table inference about the wrong
     subsystem. List verified schedules/producers separately from callable code.
   - Alternatives considered and what was removed or deferred, including cost.
   - Minimum implementation slices, exact reuse owners and tests/acceptance gates.
   - Remaining owner decisions and prerequisites; do not call them completed.
   - Sources with direct URLs and limits of their evidence.
   - A compact "Return to Codex" section with edits, unresolved disagreements
     and the next safe action. This is what Codex will read after your review.
4. Update the work-log claim to architecture-review completed, with implementation
   still unapproved. Do not label the proposed feature live or deployed.
5. Validate document links/diagram syntax and check the diff for secrets and
   unintended edits. If committing review documents, follow ship guardrails,
   scope the commit to your review files/log and state exact branch/SHA. Do not
   merge, push or deploy without the owner's applicable explicit authorization.
6. In your final response give the findings-file path, revised architecture path,
   short verdict, major corrections and remaining decisions. Do not start Builder
   work until the owner approves the reviewed architecture.

You may disagree with Codex's design. Optimize for trustworthy evidence, reuse,
operational simplicity and the owner's actual portfolio—not feature count.
