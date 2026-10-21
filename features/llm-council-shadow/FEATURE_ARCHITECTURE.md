# Multi-LLM Research Council and Scorecard

## Prediction Lab read-only comparison contract

The owner's 2026-10-21 approval adds a Learning-page projection, not a council
roster, prompt, scoring or trading change. The projection compares initial
member scores and the actual returned roster's initial median to the frozen
deterministic score on matched raw outcomes. It preserves requested/actual
model, execution source and prompt identity. It uses a common availability
close per run, the versioned research benchmark and complete regular-session
marks. Current cached marks are not sealed experiment evidence; results remain
descriptive and mixed holding/entry cohorts are labelled as such.

The corrected availability helper does not slide past a missing expected entry,
models 2026 US early closes, rejects unmodelled special sessions/years, and
requires the outcome close to have happened by evaluation time. New scheduled
subscription IC rows use `forecast_available_close_v2`; historical rows are not
rewritten. The new matched panel's paired t uses actual market-session
distances and is descriptive only. Older Council tables retain explicitly
labelled legacy descriptive t values. Full P0/P1 boundaries and later gates:
`features/prediction-lab/FEATURE_ARCHITECTURE.md` version 1.2.

## 2026-10-16 operational repair

The hybrid council's Claude/Codex subscription scores were absent because the
local supervisors were not running: both Startup entries pointed into a runtime
folder missing its scripts, and the remaining Claude credential returned 401.
The official-client runner files were restored outside the repository, the two
existing worker credentials were rotated with account-only ACLs (tokens never
printed), and both supervisors resumed. Historical expired jobs remain expired;
they cannot be treated as forecasts. The symbol council API now reports every
configured participant, including queued/leased/expired/failed members and any
fixed failure code, rather than showing an unexplained dash. It supports the
configured 1–5-member roster in that card. The generic Fundamentals overview
still has its historical three family columns (DS/CL/CX); consult the symbol
card or Settings worker evidence for exact model and per-job state. Subscription
workers still require a signed-in, awake Windows session; this repair does not
make personal subscriptions into a cloud API or promise uninterrupted service.

**Status:** Owner-approved to build on 2026-09-30. Shadow-only until evidence and a later explicit decision permit a trading integration. This supersedes the deferred annotation-only proposal dated 2026-08-20.

## Purpose

For selected, already-researched symbols, collect genuinely independent model forecasts, let the selected models challenge and revise those forecasts for a bounded number of rounds, and produce a reproducible composite score plus an orchestrator-written synthesis. Preserve exactly what each model saw, its source timestamps, model identity, token usage, and cost. Then compare every model's score and the composite with realized, benchmark-neutral returns at multiple forward horizons.

This is a testable research lane, not a claim that an LLM ensemble improves returns. It does not fetch facts from model memory as if current, and it does not change stock dimensions, eligibility, sizing, rotation, paper orders, protective orders, or live trading.

## User controls and cost guardrails

An owner-only Settings panel controls the council:

- master enabled switch; default **off**;
- 1–5 enabled model participants (a one-model configuration is a baseline; multi-model API councils must use at least two providers, while multi-worker subscription councils require both worker families);
- one orchestrator model, independently selectable and allowed to also be a participant;
- debate rounds from 0 through 3;
- maximum 1–400 symbols per market per day and a hard daily USD budget;
- explicit “shadow / not used for trading” status.

Provider API-key readiness is shown without exposing credentials. A paid
consumer membership is not a server API key. The optional subscription-worker
mode uses the official signed-in Claude Code or Codex CLI as a separately run
local worker: Kairos queues a frozen, expiring job and receives its validated
result. The personal session remains inside that client; Kairos never receives
the provider login. The owner must schedule or start the local worker, and its
machine must be awake and connected. A Claude web Routine is not currently
integrated: its available trigger returns a run reference, not a structured
result callback, and the inspected Routine is paused, lacks a project
connector, and expects an older schema. The original API mode remains separate
and uses provider API billing. No inference fallback crosses between the
modes.

One participant is allowed as a single-model baseline; it is not represented as a multi-model vote. With multiple participants in API mode, at least two providers with resolvable provider API keys are required. A multi-worker subscription roster requires both Claude and Codex families. Collection uses `all_research_v1`: the newest researched observation per symbol per market session, once per observation, regardless of whether it is a new-entry candidate, a holding review, eligible, or rejected. Candidate order is deterministic and bounded by the configured daily cap and a fail-closed scan limit. The evaluator reports both this broad research cohort and the separately frozen `near_threshold_entry_long_v1` slice; neither result should be silently substituted for the other. This broad cohort is useful for descriptive coverage but mixes entry, hold, and rejected decisions, so portfolio-selection claims must use the matching declared cohort rather than infer one from the all-research aggregate. A bounded invocation stops starting work before its 300-second route ceiling. No fallback model can silently stand in for a selected participant: if the router returns a different model, that participant is marked failed for this forecast. Groq model IDs past their published shutdown dates are excluded from the council picker even if retained for legacy agent assignments. Actual model identity and billed usage are recorded for every attempt, including failures through the existing `llm_call_log`.

Estimated API calls per symbol are `participants × (1 + effective_debate_rounds) + 1 orchestrator` where the API orchestrator is enabled; subscription-only execution has no billed API orchestrator. Hybrid collection forces debate rounds to zero because subscription queue advancement would otherwise enqueue another paid membership inference per participant. The Settings estimate is a ceiling, not a promise of latency or provider quota. API calls reserve pessimistic input/output cost before dispatch; one validation-repair attempt must reserve its own worst-case allowance before it is sent. The scheduler uses bounded concurrency and a per-invocation reserve ledger so parallel lanes cannot all spend the same remaining headroom. The DB call ledger is authoritative for actual API spend; if it cannot be reconciled, no further call should be admitted. Subscription quota is separate and cannot be converted to a dollar cap. Defaults and throughput limits are operational controls, not evidence that more symbols improve forecast quality.

## Data and forecast contract

The current collector cohort is `all_research_v1`, the newest observation per symbol per market session from the bounded recent research window. It includes entry candidates, holding reviews and ineligible/rejected observations. A second evaluation cohort, `near_threshold_entry_long_v1`, is the newest observation per symbol from the research window only when its resolved context is an entry candidate, direction is long, and deterministic score is within an inclusive ±5 points of that row's recorded threshold. It intentionally includes both eligible and rejected long candidates so evaluation can ask whether council scores distinguish near-threshold winners the deterministic gate did not select. The narrow cohort excludes holding reviews, unknown contexts, shorts, and names the app did not research; it does not answer broad-universe discovery. The half-width, key, selection time, and input observation ID are frozen in run config/snapshot. A bounded scan overflow fails closed rather than choosing from a partial universe.

The council freezes the decision-time `features`, dimension and composite scores, price/date/currency, and source provenance. It enriches that snapshot only from already-stored, point-in-time-safe relationships: `symbol_profiles` only if `updated_at <= decision_ts`; peer `decision_observations` only on the same market/session and `ts <= decision_ts`; peer `price_cache` marks only from sessions strictly before the decision date; and analyst EPS-consensus vintages only when both `available_at` and `snapshot_at <= decision_ts`. The price cache has a session date but no intraday availability timestamp, so a same-date peer bar cannot be proven available at decision time and is excluded. The snapshot labels these as app-provided peer/consensus evidence and explicitly distinguishes analyst consensus from company-issued forward guidance. This release does not fetch new news, competitor fundamentals, or management guidance; missing/stale fields remain missing/stale rather than being invented from model memory.

The independent prompt requests JSON with a numeric **0–100 outlook score**, confidence, a concise thesis, bull and bear cases, key risks, and evidence citations. A score means relative expected attractiveness over the next **10 market sessions**, not a price target or return percentage. That same score is evaluated against h2, h5, h10 and h20 outcomes to test horizon portability; those are separate evaluation cells, not four scores retroactively invented by the model. Facts must cite an existing path in the supplied snapshot and its recorded as-of date (or `unknown`). A model may state uncertainty; parse errors, unsupported scores, stale-only evidence, and provider errors do not get coerced into a numeric prediction.

Each model first scores independently, without seeing other model outputs. In every configured debate round, it sees peer scores and cited arguments from the preceding stage and may revise its score with an explicit change rationale. The orchestrator sees the original evidence and final participant reports and writes a synthesis, disagreement summary, and risks. The displayed **composite score is the median of valid final participant scores**, not an unconstrained number invented by the orchestrator. The orchestrator's narrative is not scored as another participant.

## Point-in-time integrity and evaluation

The frozen run stores the exact decision observation ID, input JSON/hash, source timestamps, prompt/config version, requested and actual models, stage scores/rationales, call status, token counts, provider-reported/router cost, and final synthesis. Run/prediction records are append-only. Later labels live only in evaluation joins; future returns are never added to the frozen prompt snapshot.

Mature `observation_labels` at h2, h5, h10, and h20 are joined to each forecast. For each model and the composite, the evaluator computes **per-session Spearman rank IC** against `benchmark_neutral_return`; it does not pool all symbols as independent observations. It never substitutes raw `fwd_return` when the benchmark-neutral label is missing: that row is omitted from this scorecard. It reports raw observations, qualifying sessions (minimum five symbols per session), the existing overlap adjustment `nEffective = qualifyingSessions / horizonDays`, and a t-stat computed from the per-session IC series using that effective sample size. Under `nEffective < 12`, IC may be shown descriptively but inferential classification/t-stat is null and the row says `insufficient_evidence`. Missing/matured labels, cohort exclusions, and provider/model fallbacks are visible.

The primary prediction is each participant's initial independent score; revised/debated scores and the median composite are separate series. This prevents the system from crediting “independent skill” to a model only after it has copied peers. Every evaluation is descriptive until there are enough independent windows; no result is a causal proof.

## Security and money-path isolation

- All reads/writes use server-side service credentials; owner endpoints require `requireOwner`, scheduled endpoints require `verifyCronSecret`.
- API keys remain in the existing encrypted key vault and are never returned to the UI or written to council rows.
- RLS denies browser writes; only owner-scoped reads are exposed through the authenticated API. Service role performs writes.
- A coupling test forbids council table/score imports from the scoring, paper/live execution, sizing, exits, rotation, promotion, and learner decision modules. The current release adds no consumer to those systems.
- Enabling the council only enables measurement. A later trading integration requires a separate architecture decision and out-of-sample evidence review.

## Subscription-worker execution mode (approved 2026-10-10)

The owner may choose API mode or subscription-worker mode. The latter uses at
most five registered worker identities, one per exact family/model pairing.
Each worker authenticates to the Kairos queue using a random revocable token
whose SHA-256 digest alone is stored. A job freezes the ordinary council packet
and hash, then provides a leased claim with a hard 45-minute deadline. Worker
results bind the job, lease, frozen-input hash, and expected model. Initial
member scores are independent; later bounded rounds receive only prior-round
anonymous scores/evidence. Median consensus is deterministic and no orchestrator
inference call is billed. A concurrent poll will not repeat an active job.

On each scheduled queue sweep, an expired lease at the two-attempt limit is
terminalized as `expired` with `lease_attempts_exhausted` before the existing
batch-advance RPC runs. This prevents a job that cannot legally be reclaimed
from holding its batch in `running` until the 12-hour deadline. The batch may
advance as partial; this does not retry inference or treat missing members as
successful forecasts.

The official-client runner has no Kairos service credentials, drops project
configuration and provider-key environment variables, disables model tools,
web search and MCPs, and uses an isolated temporary working directory. Claude
membership use requires Claude Code's own authenticated subscription session;
Codex requires a Codex CLI login using the owner's ChatGPT account. Those logins
remain local to the client. There is no server-side credential extraction or
API fallback. Workers report token use where the official client exposes it;
subscription usage is not converted to a made-up dollar charge.

Synthetic batches are identified as `TEST-NO-REAL-ASSET`, have no linked
observation or normal run, and are rate-limited. They prove transport and parsing
only. Forecasts submitted asynchronously have a later information-availability
time than the original ResearchAgent decision; therefore the existing
observation-time evaluator excludes them. A separate availability-aligned label
producer is required before subscription scores may appear in IC/t-stat results.

## Dated usage and pipeline attribution (approved 2026-10-11)

Settings → AI Models shows a 7-, 30-, or 90-market-local-day usage history. Each daily summary stays separate by market (`us` or `india`) and execution source (`api` or `subscription`); expanding a summary shows requested and actual model identity, council role, failures, token-report completeness, and subscription lease claims.

## Full-research collection scale-up (2026-10-12)

The owner approved scoring the complete set of symbols actually researched by Kairos, not every listed US security and not the broker's entire tradeable universe. The collector uses `all_research_v1` and the evaluator retains both broad all-research and narrow near-threshold entry-long series. This measures council behavior on the app's researched coverage; it does not establish that coverage itself is complete or that the council can discover names the ResearchAgent never admitted. A run is unique per research observation; failed/partial observations are not silently retried as a new observation and must remain visible in run/failure reporting.

Collection is paged in short market-local cron windows. The route caps scan size, symbol count, request duration, and concurrent lanes; hybrid mode deliberately disables debate because queue advancement otherwise creates an additional subscription job per member. API prompts cap rationales and evidence citations to preserve auditability while reducing generation length. Citations remain in the record; they are not removed merely because the evaluator uses numeric forecasts.

Budget correctness has two layers: persisted call-log spend is the baseline, while each concurrent API lane reserves worst-case estimated spend before dispatch, including one possible validation repair. After each call, the route reconciles that run's actual usage before releasing unused reserve; if reconciliation fails, the reserve remains held for the rest of the invocation. This is a pessimistic software guard, not a provider-enforced billing limit; provider price changes and calls made outside Kairos are not controlled by it. Subscription workers consume subscription quota and are not included in API-dollar estimates. A quota/auth failure pauses that local worker, but does not turn a partial batch into a completed council result.

Operational measurements on 2026-10-12 (103 US symbols, one DeepSeek Flash API call per symbol batched by the route; about $0.064 total for that API pass) are observations, not latency SLAs. Subscription workers then processed asynchronously at locally measured rates, but the first expanded run had partial US and India batches and Claude failed/expired jobs. No accuracy or performance benefit is established. Do not re-run paid work solely to fill missing members without checking current provider quota and approval; collect fresh eligible observations on the next session and report partial coverage honestly.

API usage is read from `llm_council_turns`, preserving each independent/debate/orchestrator stage and the requested-versus-returned model. Token totals and cost come from the persisted turn result. The displayed dollar amount is Kairos' router estimate, not an invoice. A failed stage with no returned model is marked as having unknown token use/cost unless its persisted reason proves the request was rejected before dispatch (`provider_key_missing` or `prompt_too_large`).

Subscription usage is read from non-synthetic `llm_council_jobs` joined to its research run and worker family. Token values remain unknown if the official client did not report them; subscription use is not assigned a fabricated API dollar cost. A row counts one persisted stage/job, not guaranteed provider invocations: the queue can reclaim an expired lease and the current schema cannot prove whether a timed-out worker consumed membership usage before its result arrived. Lease claims are displayed separately, and expired jobs without a submitted result are visible as uncertain usage on the queued/lease day. Synthetic `TEST-NO-REAL-ASSET` batches are excluded.

US dates use `America/New_York`; India dates use `Asia/Kolkata`. API stages use their persisted turn timestamp. Subscription rows use result submission time when present and explicitly use queue/lease time when the job expired without a report. The database function bounds the scan to the chosen window (with a short queue-deadline buffer), validates the allowed lookbacks, and is executable only by `service_role`; the authenticated route additionally requires `requireOwner`. There is no new public data surface, browser-side service credential, score consumer, schedule, or money-path behavior.

## Surfaces, decision-slot timing and viewer boundary (2026-10-13)

The council is a new, independent score dimension, so it is shown wherever the other dimensions are, always labelled
**shadow** and always display-only. Owner and viewer see the same stored scores; only configuration stays owner-only.

| Surface | What it shows | Source (stored rows only) | Roles |
|---|---|---|---|
| **Fundamentals page** (`/dashboard/research`) | Four sortable, exportable columns in the Scores group and the Scores view: `LLM` (composite median), `DS` (DeepSeek), `CL` (Claude), `CX` (Codex), newest research run per symbol; blank until the council has scored that symbol; formula panel explains them | `/api/research/universe` (latest mode, fail-soft) via `lib/research/council-latest.ts` | owner + viewer |
| Symbol page → Score History chart | `LLM council (shadow)` line + toggle + latest score bar, one point per day (last council run of the day) | `/api/research/scores` (merges council days) | owner + viewer |
| Symbol page → Council card | median, DeepSeek/Claude/Codex scores, deterministic score, council minus deterministic, member disagreement, last 12 observations, member reasoning | `/api/research/council` | owner + viewer |
| Symbol page → Council panel | provider keys, config, turns, spend | `/api/agents/llm-council` | owner only |
| Score Tracker (single-symbol decision chart) | `LLM council (shadow)` series on the exact decision observation | `/api/charts/score-history` (exact observation match) | owner + viewer |
| Learning page → "LLM Council · rank IC (shadow)" | per member, composite, deterministic baseline and 50/50 blend: observations, sessions, independent windows, mean rank IC, t-stat, state, per horizon and cohort; daily coverage per member | `/api/learning/council-ic` | owner + viewer |
| Trading page (pending signals, paper trades) | inline `Council 58 (60 · 55 · 58)` beside the deterministic score | `/api/research/council/latest` | owner + viewer |
| Upgrade Path | program `llm-council-shadow` (operational-only attribution), liveness probe on `llm_council_runs` | registry + liveness | owner |
| System Health alerts | `council-unscored:<market>` (newest observation unscored >90 min); `council-workers-stalled:<family>` (selected subscription jobs queued >2 h; fresh heartbeat means active backlog, no heartbeat for 30 min means stopped worker); `council-monitoring:worker-queue` if the monitor cannot read the queue | stale-check | owner |
| System Health alerts (divergence) | `council-divergence:<market>` (category `models`): a HELD or ENTRY-ELIGIBLE symbol whose council median differs from the deterministic composite by >= 20 points AFTER removing the market's own median offset (India ran ~12.6 below, US ~3.7 below on 2026-10-13), or whose three members disagree by >= 25 points. Lists up to 8 symbols with reasons; resolves when none; informational only (the trader never reads council scores) | stale-check every 4 h; `lib/monitoring/council-divergence.ts` | owner |

**Not integrated, on purpose:** the paper trader, rotation, exits and sizing (shadow-only until evidence); the Learner's weight mutation and dimension IC ledger (those
evaluate the five scoring dimensions; the council has its own per-model IC with different sample rules, so it is reported beside them
rather than inside them). Viewers never trigger a model call: every route above reads stored rows.

**Decision-slot timing.** The council scores every NEW research observation (newest per symbol, at most 12 h old, not already scored),
so each research run, and the paper-trade slot that follows it, has a matching shadow forecast. pg_cron windows (UTC, Mon-Fri, every 5 min):
India 04-05 (research 04:00/05:00, trader 04:10), 07-08 (research 07:00, trader 07:45), 11-12 catch-up; US 13-16 (research 09:00 ET,
trader 11:15 ET), 18-20 (research 14:00 ET, trader 15:15 ET), 22-23 catch-up. DeepSeek completes within minutes; Claude and Codex run on the
owner's PC and finish roughly 10-30 minutes later, so for the India 04:00 slot (trader at 04:10) the local-worker scores arrive after the trade.
Claude and Codex forecasts are evaluated with availability-aligned labels (first close after the forecast was returned).

## Worker monitoring and recovery (2026-10-20)

The queue-health check is scoped to the configured subscription worker IDs, ignores synthetic jobs, and joins the registered worker's `last_seen_at`. Old queued jobs remain visible as a score-latency warning; if a worker has claimed work in the last 30 minutes the warning says it is actively draining a backlog, not that it is offline. If no heartbeat has arrived in 30 minutes, the warning names the likely local causes (PC/session unavailable, CLI sign-in, or usage pause). A failed queue query raises `council-monitoring:worker-queue` and does not resolve prior worker alerts. The daily Codex watchdog checks local supervisor existence and production member/job status; it may restart an existing supervisor only when the private config is present and the signed-in session is available. It never rotates credentials, changes models/roster, or launches extra test inferences. Local Claude/Codex membership use still cannot operate while the owner workstation/session is unavailable; API-provider uptime is also outside Kairos's control.

## GPT-5.6 Luna and paired deterministic comparison (implemented locally 2026-10-11)

The API model catalogue now includes `gpt-5.6-luna`, with explicit `medium`
reasoning effort, completion-token accounting and the published API token rates.
The Settings picker calls out the recommended three API participants—DeepSeek
Flash, GPT-5.6 Luna (medium), and Claude Sonnet 4.6—while the orchestrator remains
separately selected. The council stays off until the owner enables it and all
required provider API keys are present. GPT-5.6 Luna was also exercised once via
the existing signed-in Codex CLI worker using only a synthetic
`TEST-NO-REAL-ASSET` packet; it returned a structured score and token counts.

The evaluator now adds `deterministic:analyst_score_paired` and
`blend:equal_weight_50_50_paired`. Both are calculated only on the exact
run/label observations where a valid council median and deterministic composite
coexist. The 50/50 blend is frozen, measurement-only and deliberately not fit to
the same history. Compare those rows with `composite:median` at h2/h5/h10/h20;
they remain descriptive under the same session and overlap gates.

**Hybrid mode and delayed evaluation (merged and production-deployed 2026-10-12, PR #66):**
The roster can contain one or more metered API members (for example DeepSeek)
plus official Codex/Claude subscription workers, with a hard maximum of five
members in total. Hybrid mode makes one independent API forecast per selected
API member; debate rounds, when selected, are limited to subscription workers.
The final score is a deterministic median across every successfully persisted
API and subscription forecast, and remains null unless the complete selected
roster succeeds. There is no API orchestrator call in hybrid mode, no silent
fallback, and API calls remain bounded by the configured daily budget. The
entire feature remains disabled by default and has no trading consumer.

Subscription forecasts are stored with source and availability timestamps at
insert time. The separate `forecast_available_close_v1` evaluator starts at
the first valid regular-session close strictly after a forecast is available,
then measures h2/h5/h10/h20 benchmark-neutral close-to-close returns using the
versioned research benchmark. It requires complete symbol/benchmark closes on
every included session and fails closed outside the maintained market-calendar
years. It reports gross market-price movement, not fill-level or execution P&L.
The original decision-time cohort is unchanged; asynchronous subscription
scores are not backdated into it. Historical forecast ledgers remain immutable;
legacy subscription rows without trustworthy availability timestamps are
displayed as unknown and are excluded from the delayed cohort.
Codex CLI JSONL events do not report the executed model ID, so its worker can
prove the requested CLI model was accepted and a structured result returned,
but not independently attest a provider-reported actual model identity. Claude
subscription use is unverified until the Claude Code client is signed in and
passes a synthetic test. No subscription/API blend is silently represented as
one verified execution path.

## Delivery sequence

1. Versioned settings and append-only run/forecast/turn/evaluation schema; test auth and database constraints.
2. Bounded shadow collector with independent calls, up to three debate rounds, consensus median, exact provenance, and hard call/cost caps.
3. Scheduled evaluator over matured h2/h5/h10/h20 labels using the shared cohort and IC methodology; persist each model/composite/horizon result.
4. Settings controls and council dashboard: latest score/rationale/as-of date per symbol, dissent, model identity, calls/tokens/cost, and IC evidence maturity. Subscription mode also shows worker registration, revocation, liveness, synthetic round trips, per-job state, and dated usage by market/pipeline; its forecasts stay out of IC until availability-aligned labels exist.
5. Tests: malformed output, provider fallback, stale/missing evidence, idempotency, disabled config, cap enforcement, owner/cron auth, label maturity, cohort integrity, horizon overlap floor, and proof no trading consumer exists.

The local hybrid implementation is not production verified until its migration
is released, selected workers pass synthetic round trips, and real labels
mature. Codex CLI JSONL does not independently attest the executed model ID.
Claude subscription use also requires an authenticated Claude CLI and its own
synthetic test. A local implementation does not prove unattended worker
scheduling or enable the council.

## Deliberately not included

No autonomous web research, no new paid data-source calls, no LLM edits to deterministic dimension scores, no model-generated price targets/stops, no trade decisions, no automatic provider/model rotation, no prompt-learning from future labels, and no live/paper money-path coupling. Each would need independent evidence and approval.

## Prior draft reconciliation

The 2026-08-20 draft's recommendation to defer and its binary disagreement-only success test no longer match the owner's explicit 2026-09-30 request. Its essential safety boundary (no money-path consumer) remains. This document implements model-level scores and horizon-specific rank-IC/t evidence instead of treating “agreement vs disagreement” as sufficient evaluation.
