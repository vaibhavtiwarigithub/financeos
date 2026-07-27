# Robinhood Agentic Evidence — Feature Architecture

> Status: P0 approved and implemented. Later phases require a separate owner-approved design and evidence gate.
> Scope: US only. Robinhood's MCP capability surface is observed, not trusted as a data provider or trading policy.

## P0: Capability Snapshot

The weekly route opens an authenticated MCP session and invokes only `initialize`,
`notifications/initialized`, and `tools/list`. It stores the sorted tool names,
tool count, and a SHA-256 fingerprint of the name plus input-schema contract in
the append-only `broker_mcp_capability_snapshots` ledger. Raw descriptions and
schemas are intentionally not persisted because they are untrusted remote input.

It does not invoke `tools/call`; therefore it cannot consume data-provider quota,
read accounts or positions, create research evidence, change scores, change
eligibility, create paper orders, or create live orders. An unavailable connection
is an observation, not a System Health incident or a trading gate.

## Deferred Phases

1. Owner-run, allowlisted contract probes for `get_financials`, earnings, and
   technical tools. Each probe is bounded and records no raw payload in an LLM
   context.
2. A `robinhood` adapter inside the existing Canonical Evidence Router, using
   its cache, pacing, provider-call ledger, provenance, health, and schema
   validation. No parallel evidence truth layer.
3. Shadow-only field-level comparison and point-in-time walk-forward validation.
   A broker field cannot alter a score merely because it is available.
4. Separately, retain `review_equity_order` as a fail-closed pre-trade safety
   gate. Capture its contract only after an approved execution-specific design;
   it is not part of research evidence.

No scanner, Level 2, tax lots, options, or Robinhood data call is enabled by P0.
