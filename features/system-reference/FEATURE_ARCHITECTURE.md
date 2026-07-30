# System Reference Architecture

> Status: Approved
> Implementation allowed: Yes
> Last updated: 2026-07-30

## Goal

Replace the stale, hardcoded Architecture tab on Dashboard -> Agents with a
maintainable owner-only reference surface. Preserve the live agent diagram as the
topology authority and do not add a new main-navigation documentation area.

## Scope

- Curated documents grouped by orientation, architecture chapters, decisions, and
  selected feature designs.
- Owner-gated read/download endpoint backed by a fixed document registry.
- Architecture portal, concise system overview, and chapter-index governance rules.
- Existing Agent & Flow Architecture visualization remains in place below the tabs.

## Contract

`GET /api/system-reference/:documentId`

- Requires the confirmed owner through `requireOwner()`.
- `documentId` must resolve from `SYSTEM_REFERENCE_DOCUMENTS`; unknown IDs return 404.
- The server reads only the fixed registry path and returns Markdown with `private,
  no-store` caching and `nosniff`.
- `?download=1` changes disposition to attachment. No request value is used to form a
  filesystem path.

## Non-goals

- No repository/file browser, editor, search index, public docs portal, or markdown
  authoring workflow.
- No architecture state in Supabase and no user-provided documents.
- No provider, data, scoring, paper, live execution, broker, or schema change.
- No duplicate static agent topology; the JSON map remains canonical.

## Governance

The portal explains ownership. `docs/arch/` is the detailed operational architecture;
feature documents are micro-architecture; implementation result files record delivery;
project decisions capture approval and rationale. An agent-flow change updates the
diagram source and history, then its relevant chapter. A drift test guards the diagram
contract.

## Acceptance criteria

1. The old hardcoded architecture content, including stale schedules and account
   fragments, is removed from the client bundle.
2. The System Reference tab supports opening and downloading only allowlisted files.
3. Anonymous/non-owner calls receive the usual owner-gate response; traversal-like
   identifiers cannot return a repository file.
4. The live topology remains visible and linked from the reference panel.
5. TypeScript, focused tests, and production build pass.
