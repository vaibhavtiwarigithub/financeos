# Review Prompt - Governed External Research Integrations

Review `features/external-research-integrations/FEATURE_ARCHITECTURE.md` as an
adversarial architecture review for Kairos, a Next.js 15 + Supabase quant app
with paper and approval-required live trading across separate US/USD and
India/INR books.

This is **design review only**. Do not write code, migrations, install packages,
change credentials, enable providers, or enable any trading behavior.

Read first:

- `AGENTS.md`
- `docs/arch/04-database-schema.md`
- `docs/arch/05-crons-and-scheduling.md`
- `docs/arch/08-risk-and-safety.md`
- `docs/arch/09-learning-loop.md`
- `features/data-source-policy/FEATURE_ARCHITECTURE.md`
- `features/benchmark-alpha/FEATURE_ARCHITECTURE.md`
- `features/capital-rotation/FEATURE_ARCHITECTURE.md`
- current broker/execution gateway, PaperTrader, PositionMonitor, LearnerAgent,
  and existing validation code as needed to verify the stated boundaries.

Evaluate the proposed Integration Registry, deferred isolated-compute design, and
external research adapters. Confirm whether deferring the worker until a genuinely
untrusted integration is the right scope. Report findings ranked by severity. Each finding
must include: file/section, concrete failure scenario, why an existing Kairos
control would not stop it, and the smallest design correction.

Focus especially on:

1. **Broker and money-path isolation:** prove or disprove that a worker, job
   token, artifact, Settings control, queue entry, or integration update cannot
   bypass pause/kill/drawdown/market/account/approval gates or reach broker MCP
   tools. Identify any hidden shared credential or route risk.
2. **Database/RLS/RPC containment:** can the worker append only its own run and
   artifact records? Can it alter strategy versions, decisions, scores,
   proposals, configuration, financial ledgers, or another market? Is a
   job-specific token materially enforceable with the current stack?
3. **Supply chain and deployment:** pinning, SBOM, artifact digest, upstream
   deletion, license drift, CI build isolation, GitHub Actions private-repository
   quota/no-paid-overage guard, `docker run --network none` containment, trusted
   workflow-wrapper callback identity, Vercel boundary, package install scripts,
   and rollback sufficiency.
4. **Network and secret safety:** default-deny egress practicality, DNS bypass,
   metadata endpoints, prompt/data exfiltration, logging/redaction, filesystem
   mounts, browser profiles, environment inheritance, and provider credentials.
5. **Research correctness:** ensure a future snapshot literally consumes the
   Canonical Evidence Router's `EvidenceEnvelope` rather than recreating provider
   provenance; then assess point-in-time inputs, adjusted prices, corporate
   actions, US/USD vs India/INR isolation, benchmark matching, deterministic
   replay, stale/missing data behavior, result reproducibility, and numerical
   tolerance.
6. **LLM/advisory containment:** prompt injection, structured output validation,
   feature grammar, human conversion, and every path by which an advisory result
   might become a score, candidate, paper fill, or live proposal.
7. **Architecture fit:** whether this reuses the canonical evidence router,
   validation engine, Performance Truth Layer, `strategy_versions`, and
   append-only ledgers rather than creating a parallel system.
8. **Practicality:** whether Phase 1 is small enough to prove the boundary;
   recommend the smallest safe worker hosting/runtime and identify any
   prerequisite architecture that must be approved first.

Also provide:

- A short **what is sound** list.
- A corrected phased build order.
- Exact approve/block conditions for Phase 1.
- The single riskiest assumption to validate first.

Do not treat any external repository, README, claimed backtest, GitHub stars, or
LLM output as trustworthy. In particular, do not approve OpenBB code/runtime
without resolving AGPLv3 implications, and do not grant any external integration
broker, vault, service-role, MCP, shell, or direct provider authority.
