# Monthly council model catalog review â€” 2026-11-02

Scope: owner-authorized catalog maintenance on `codex/model-catalog-review-2026-11`.
Public official documentation and local public CLI artifacts only. No provider
inference, credentials, private worker config, saved settings, database access,
migration, enablement, trading change, deployment or merge.
The review branch alone has `git.deploymentEnabled=false` in `vercel.json` to
prevent a PR push from automatically deploying. All existing deployment rules
and cron configuration are preserved, following [Vercel's branch configuration](https://vercel.com/docs/project-configuration/git-configuration).

## Verified API findings and decisions

| Provider | Evidence and decision |
| --- | --- |
| OpenAI | [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) verifies exact ID `gpt-6-luna`, text output, Chat Completions, standard $0.10 input / $0.50 output per million tokens, and none/low/medium/high/xhigh/max effort. Add this efficient successor as an optional council model at fixed medium effort, using `max_completion_tokens` and the existing 16,000 reasoning budget floor. Council requests use no tools; the documented Chat Completions tool restriction therefore does not apply. No automatic selection. [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna) remains $0.20/$1.20 with medium supported; preserve it. |
| OpenAI lifecycle | [Deprecations](https://developers.openai.com/api/docs/deprecations) schedules GPT-4o, GPT-4o mini and GPT-4.1 shutdown on January 14, 2027. Label these choices deprecated with that date. Preserve their IDs, legacy references, saved settings and executable contracts until a separately verified removal; do not rewrite historical evidence or fallbacks. |
| Anthropic | [Pricing](https://platform.claude.com/docs/en/about-claude/pricing) gives Haiku 4.5 $1/$5, not Kairos's $0.25/$1.25. Correct both alias and dated snapshot. Sonnet 4.6 remains $3/$15. [Lifecycle](https://platform.claude.com/docs/en/about-claude/model-deprecations) lists Sonnet 4.6 and Haiku 4.5 active. [Current catalog](https://platform.claude.com/docs/en/models/overview) lists Fable 5.1, Opus/Sonnet/Haiku 5.5; do not bulk-add them without model-specific adaptive-thinking, output-limit and usage tests against the installed SDK adapter. |
| Google | [Pricing](https://ai.google.dev/gemini-api/docs/pricing) gives text Gemini 2.5 Flash $0.30/$2.50, not $0.075/$0.30. Correct it. Pro remains $1.25/$10 for <=200k input, above the council's 45,000-character prompt cap. [Thinking accounting](https://ai.google.dev/gemini-api/docs/generate-content/thinking) bills candidate plus thought tokens; include `thoughtsTokenCount` once in logged output/cost. `maxOutputTokens` bounds their combined total. [Lifecycle](https://ai.google.dev/gemini-api/docs/deprecations) says 2.5 remains served for existing users with no announced shutdown; do not retire it. Current 3.8 Flash / 3.5 Flash-Lite and Argon have separate contracts/prices, including promotional expiry dates; leave them outside this bounded curated addition rather than assume adapter readiness. |
| xAI | [Current catalog](https://docs.x.ai/developers/models) lists `grok-4.7`, $2/$6; [reasoning](https://docs.x.ai/developers/model-capabilities/text/reasoning) supports low/medium/high/xhigh, default high. [May retirement notice](https://docs.x.ai/developers/migration/may-15-retirement) explicitly redirects the dated `grok-4-0709` and suffixed fast-reasoning/non-reasoning IDs to `grok-4.3` at $1.25/$2.50. It does not establish the exact bare `grok-4-fast` contract used in Kairos. Do not guess its replacement, price or retirement from a similar slug. Exact bare-alias verification is blocked; existing xAI estimates remain unverified. No xAI dropdown change until exact-alias evidence and adapter tests exist. |
| DeepSeek | [Models/prices](https://api-docs.deepseek.com/quick_start/pricing/) verifies `deepseek-flash` = V4.1-Flash-1017 and `deepseek-v4-pro` = V4-Pro-0813. Existing off-peak cache-miss/output rates $0.15/$0.60 and $0.66/$1.98 remain correct; weekday peak rates double, excluding Chinese public holidays. Existing peak estimator is conservative on those holidays; no new holiday dataset or pricing policy introduced. [Thinking](https://api-docs.deepseek.com/guides/thinking_mode/) supports low/high/max; existing explicit Flash disabled / Pro high remains valid. Preserve the release stamp and historical evidence split. |

All rates above are standard first-party API USD per million tokens, never
subscription charges. The shared router changes affect future cost logging only;
historical costs are not rewritten. Larger-context, caching and service-tier
discounts are outside this text-only bounded council reservation, which uses
uncached input rates conservatively.

## Installed membership clients â€” separate evidence

* `codex --version`: **0.145.0**, resolved through the npm launcher. Its help
  accepts an exact `--model`; no inference was launched.
* The public local `~/.codex/models_cache.json` was fetched November 2 and stamped
  **client_version 0.166.0**. Its IDs include `gpt-6.1-sol`, `gpt-6-astra`,
  `gpt-6.1-terra`, `gpt-6-sol`, `gpt-6-luna`, the three GPT-5.6 variants,
  `gpt-reserve`, and `codex-auto-review`. This newer client's cache does **not**
  establish entitlement or execution by installed CLI 0.145.0. No cache-derived
  ID is promoted to an API dropdown. GPT-6 Luna is added on independent API docs.
  Cached Luna effort choices are low/medium/high/xhigh/max, distinct from the API
  list that also permits none.
* `claude --version`: **2.1.296**. Help advertises fable/opus/sonnet aliases and
  `--effort`. Public executable strings include `claude-fable-5-1`,
  `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, Sonnet 4.6 and
  Haiku 4.5, alongside retired compatibility IDs. Strings are client recognition
  evidence, not account entitlement. [Claude Code model configuration](https://code.claude.com/docs/en/model-config)
  makes access/usage credits plan-dependent. Membership-backed execution remains
  unverified in this run; no auth/private settings were read and no synthetic
  job was queued. The worker registration form remains an exact supported ID
  input, not an API-catalog-backed subscription picker.

## Implementation and validation

Inspected `llm-model-catalog`, router dispatch and all five provider adapters,
council picker, subscription runner, reservation/repair bounds, focused tests,
feature architecture and WORK_LOG before implementation. Graphify supplied
structural orientation; exact source was then read.

The council calls `task=evaluate`; Claude's adapter raises a nominal 900-token
request to 3,584 (2,048 thinking + 1,536 answer allowance). Reserve that actual
ceiling for first and repair calls, using corrected prices. No call budget,
thinking setting, prompt, roster or score changes.

Validation: 134 focused tests across 23 files passed; full-project TypeScript,
diff checks and staged credential-pattern checks passed. The isolated build
without environment files or inherited provider secrets passed compilation and
build type checking, then failed prerendering `/auth/confirm` because the
Supabase client requires configuration. No real configuration was loaded to
work around that boundary. The initial copy omitted `tailwind.config.ts`; that
copy-only error was corrected before the final build attempt.
Tests use synthetic mocked keys/responses and no provider/network inference.

Remaining verification limits: xAI bare alias identity/pricing and actual
membership availability cannot be attested from this read-only review. Current
larger-model candidates are intentionally not a claim of adapter compatibility.
