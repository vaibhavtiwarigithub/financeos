# Subscription council workers

Owner approved 2026-10-10: use Claude and ChatGPT memberships without paid Anthropic/OpenAI inference APIs. The implemented bridge runs the official Codex or Claude Code CLI on an owner-controlled machine where that client is signed in. It is not a cloud-membership bridge.

Why: the owner already pays for these personal research assistants. Who: the Kairos owner only. Expected benefit: measure their forecasting value using existing allowances; no assumed investment improvement. ShippedAt: pending.

## Contract

The existing API council remains available. A separate subscription execution mode queues frozen jobs instead of invoking inference providers. Owner registers up to five selected workers, each with a family (Claude or Codex), expected model, and revocable random Kairos credential stored only as a SHA-256 digest. This credential grants only claiming that worker's jobs and submitting its results; it is not a provider login and cannot read portfolios or execute trades.

The shared near-threshold collector freezes evidence once. Subscription batches reference ordinary council runs; synthetic batches have no observation/run linkage and never enter IC. Jobs are leased atomically, have a hard batch deadline, and accept one immutable result per worker/round. Every result must bind packet hash, job, lease, expected model and valid citations. Retries of the same accepted result return success; conflicting or expired results fail. All selected members must finish a round before a subsequent debate round opens. Debate peers are anonymous and final consensus is a deterministic median; no paid orchestrator is called.

Async forecasts record their actual availability time. Existing observation-time labels cannot grade a delayed subscription forecast: exclude these runs from that evaluator until a forecast-availability-aligned label producer is verified. Show the limitation explicitly. Never relabel synthetic tests as forecasts.

## Implementation and migration

Add service-only worker, batch and job tables with RLS and invoker RPCs for atomic claim/submission/progression. Add config execution_mode and subscription_worker_ids with defaults preserving API mode and disabled state. Owner routes register/revoke workers and create synthetic batches. A separate bearer-authenticated worker route exposes claim and submit. Node worker runs official signed-in Codex or Claude CLI and validates structured output. The worker must be scheduled or started by the owner; its machine must be awake and connected. The available Claude web Routine trigger returns a run/session reference, not a structured result callback into Kairos. The currently inspected Claude Routine is paused, has no project connector, and its test prompt expects an older schema. Therefore Claude cloud Routine execution is not integrated; do not call it a worker until a supported authenticated connector is built and contract-tested.

Subscription sessions remain in the provider client. Kairos never reads or stores those credentials. No fallback to a paid API. Missing quota, authentication, model evidence or a deadline gives a visible failed/expired job, not an invented score. Token counts are nullable when unavailable; subscription usage is not presented as free inference or a fabricated API dollar charge.

## Acceptance

Test wrong-worker, revoked token, duplicate/conflicting submission, expired/reissued lease, disabled master, missing member, invalid JSON/citations, model mismatch and synthetic isolation. The Codex membership-backed CLI has completed a synthetic round trip on the account-supported model `gpt-5.6-sol`; Claude CLI remains unverified until the owner signs in to Claude Code and runs its synthetic round trip. Confirm the app displays each result and deterministic median before enabling the real collector. Subscription mode needs no inference API keys. Track calls and available tokens without fabricating a dollar amount; measure skill only from eligible matured labels. Cloud Claude Routine execution remains unavailable under the present integration surface.

## Owner setup (local membership worker)

1. In Settings → AI Models → Multi-LLM research council, choose **Subscription workers**. Register a worker with an exact model ID supported by the installed signed-in client. Registration returns a one-time `kcw_…` credential; copy it directly to a private local config file, not a prompt, chat, repository, or shared cloud secret store.
2. Create a private JSON config containing only `origin` (the Kairos HTTPS origin, no path) and `token`. Keep the file outside the checkout, for example under `%LOCALAPPDATA%\Kairos\council-worker.json`; restrict it to the Windows account. Do not paste the token into a shell command, since command history can persist it.
3. With Codex CLI signed in to ChatGPT, run `node scripts/council-subscription-worker.mjs <private-config-path>` once to claim and process one job. To test, select the worker in Kairos, queue a synthetic test, then run `node scripts/council-subscription-worker.mjs <private-config-path> --synthetic-only`. A missing CLI login is shown as a failed test, not silently replaced by an API call.
4. For recurring collection, schedule this command locally at a modest interval (for example every 5 minutes during expected research windows). The app queues at most its configured daily symbol limit; when no job exists, the runner exits. Windows Task Scheduler runs only while the machine/session conditions you configure permit. No supported cloud executor currently consumes personal ChatGPT or Claude memberships.
5. Claude Code Pro works by the same local process only after `claude auth status` confirms an authenticated Claude subscription session. That state is currently logged out in the verified environment, so a Claude worker cannot pass its required synthetic test yet. Revoke a worker in Settings to invalidate its credential immediately.

Council master enablement remains a separate, explicit switch after every selected worker passes the synthetic test. It turns on shadow collection only, not trading. Subscription forecasts are not included in IC until availability-aligned label production is verified.

References: https://platform.claude.com/docs/en/api/claude-code/routines-fire ; https://code.claude.com/docs/en/routines ; https://learn.chatgpt.com/docs/non-interactive-mode ; https://learn.chatgpt.com/docs/auth
