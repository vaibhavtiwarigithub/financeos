# Code reuse protocol for coding agents

This protocol applies to Codex, Claude Code, and other agents implementing Kairos.
Its purpose is to make agents understand the existing implementation before adding
another one—not to force reuse when the existing design is wrong.

## Before editing

1. Read `AGENTS.md`, `WORK_LOG.md`, the relevant architecture chapter, and the
   feature architecture or decision record when one exists. Claim the task before
   implementation and do not overlap another active claim.
2. Search for the behavior, not just the proposed feature name. Use `rg` for
   definitions, call sites, API routes, schedules, migrations, and tests; use the
   Graphify/code graph to trace likely callers and dependencies. Verify graph hits
   in source because generated indexes can be stale.
3. Inspect the current owner end-to-end: inputs, outputs, persistence, consumers,
   failure behavior, tests, and any market/account boundary. Check whether an
   existing helper, registry, ledger, provider adapter, or UI surface already owns
   the capability.
4. Record a short reuse decision in the task claim or implementation notes:
   - **Reuse/extend:** identify the existing module and contract to preserve; or
   - **New component:** show the searches and explain the missing or incompatible
     ownership boundary that makes a new component necessary.
5. If the apparent implementation is defective, prefer fixing its canonical owner
   and adding regression tests over introducing a second path. Reuse is not a
   reason to preserve unsafe behavior or force unrelated domains into one abstraction.

## Plan, then execute at the right scale

- For ambiguous, cross-cutting, schema-changing, or money-path work, first state
  the current owner, proposed in-place reuse, data/API effects, edge cases, and
  verification gates. Follow Kairos's architecture-approval rules before coding.
- For a bounded bug fix with an obvious owner, keep this lightweight: identify the
  implementation and callers, explain the targeted correction, add a regression
  test, and proceed only within the user's authorization. Do not make a plan-only
  ceremony a substitute for finishing approved implementation.
- A separate chat or plan document is useful when the workstream changes or the
  handoff is long-lived; it is not inherently better for every task. Carry forward
  the task claim, accepted decisions, relevant files, and test evidence—not a dump
  of the entire conversation.

## Keep context useful, not merely small

Scope initial searches to the likely subsystem, then widen when call sites, shared
contracts, schedules, or persistence show the behavior crosses boundaries. Load only
the tools and references needed for the task, but do not disable a configured tool
or remove a required source merely to reduce context size. Prefer concise repo-wide
rules with pointers to focused references; remove stale or duplicated instructions
when they conflict or repeat the same policy.

There is no fixed message-count rule for starting a new session. Start a fresh task
or compact when the active context is dominated by unrelated history or has become
hard to audit; preserve the durable handoff in `WORK_LOG.md` and the owning design
document so the new session can re-derive current truth from the repository.

## When a change starts duplicating code

If review finds a second implementation of existing behavior, stop adding to the
duplicate path. Trace which owner is authoritative, compare contracts and consumers,
and consolidate into that owner where safe. Do not automatically revert or rewrite
an entire change: preserve unrelated work, state the precise duplicate and its
impact, and use tests to prove the canonical path still works. A rewrite is a
deliberate recovery choice, not a two-strike punishment.

## Before adding a persistent or scheduled path

Search for equivalent tables, RPCs, API routes, cron jobs, provider-call ledgers,
and shadow registry entries. Prefer extending an existing append-only contract and
producer when semantics match. Add a new table, route, or schedule only when its
ownership, lifecycle, or data contract is materially distinct; document why in the
feature architecture and include migration/schedule tests where applicable.

## Completion notes

Report what was reused, what was changed in place, and why each genuinely new file,
table, route, or schedule was required. Run the focused regression tests for the
existing owner and its consumers. Keep architecture docs synchronized when shipped
contracts change. Do not maintain a second manually curated catalog of every symbol
or function: use the architecture index for subsystem ownership and live source/code
navigation for exact implementation details.

## Source-of-truth order

1. Current source, migrations, and tests establish what is implemented.
2. `docs/arch/` and feature architecture documents describe intended ownership and
   contracts; resolve drift rather than treating stale docs as executable truth.
3. `WORK_LOG.md` records active work, decisions, and evidence, not a substitute for
   tracing callers.
4. Graphify and IDE symbol navigation accelerate discovery, but must be checked
   against current source and refreshed only within the approved change scope.

## Further reading

- [Codex development workflows](https://developers.openai.com/cookbook/examples/codex/iterating-development-workflows-with-codex)
- [Codex prompting and context guidance](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide)
- [Claude Code project memory](https://docs.anthropic.com/en/docs/claude-code/memory)
- [GitHub code navigation](https://docs.github.com/en/repositories/working-with-files/using-files/navigating-code-on-github)
