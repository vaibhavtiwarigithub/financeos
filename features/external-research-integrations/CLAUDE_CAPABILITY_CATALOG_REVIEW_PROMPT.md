# Review Prompt - External Repository Capability Catalog

Review `features/external-research-integrations/REPOSITORY_CAPABILITY_CATALOG.md`
against the current Kairos implementation and architecture. This is design review
only. Do not install packages, clone repositories, edit implementation code,
create migrations, enable `router_enabled`, change credentials, or change any
paper/live behavior.

Read first:

- `AGENTS.md`
- `WORK_LOG.md`
- `features/external-research-integrations/FEATURE_ARCHITECTURE.md`
- `features/data-source-policy/FEATURE_ARCHITECTURE.md`
- `docs/arch/04-database-schema.md`
- `docs/arch/05-crons-and-scheduling.md`
- `docs/arch/08-risk-and-safety.md`
- `docs/arch/09-learning-loop.md`
- current Evidence Router implementation, Settings -> Data routes/UI, research
  scoring, validation, PaperTrader, and broker execution gateway as needed.

The catalog is meant to answer: for each reviewed GitHub repository, what exact
capability should Kairos use, build itself, borrow as methodology, defer, or
reject? It must never turn GitHub popularity into execution authority.

Report findings ranked by severity. For each finding give the catalog section,
concrete failure scenario, and smallest correction. Evaluate:

1. **Completeness:** are all 25 unique repositories previously reviewed across
   the FinTech and Quantitative Finance scans represented? Is any useful
   capability materially missing or overstated?
2. **Current-state accuracy:** does the catalog correctly distinguish capabilities
   already delivered by the Router Phase 2 shadow foundation from ones that remain
   future work? Verify that the catalog does not imply `router_enabled=true` or a
   scoring cutover.
3. **Architecture fit:** do recommended capabilities reuse the Canonical Evidence
   Router `EvidenceEnvelope`, current Validation Engine, Performance Truth Layer,
   strategy lifecycle, and append-only ledgers rather than create competing data,
   backtest, or portfolio systems?
4. **Money-path safety:** prove no proposed capability can reach a broker, account,
   credential vault, service-role database access, provider bypass, paper fill,
   live proposal, scoring weight, sizing, or execution gate. Flag any wording
   that could be interpreted otherwise.
5. **License/supply-chain honesty:** are code-use recommendations correctly
   conditioned on exact-release license, dependency, source, and security review?
   In particular, verify OpenBB's non-adoption boundary and that no Vibe/TA-Lib/
   Qlib recommendation implies a dependency approval.
6. **Research correctness:** evaluate point-in-time data, US/USD vs India/INR
   isolation, benchmark/cost provenance, formula semantics, provider data
   availability, small samples, and validation/promotion gates.
7. **Product value:** are the few recommended capabilities likely to improve an
   explainable novice-first trading product, or are they generic quant complexity?
   Recommend removals where the value is not concrete.
8. **Sequencing:** is the instruction to wait for Router shadow parity and the
   eligibility-flip guard before external integrations correct? Identify the
   smallest legitimate next capability after that gate.

Also provide:

- A short **what is sound** list.
- A corrected top-five priority list, with `build_ourselves`, `reference_only`,
  `deferred_candidate`, or `do_not_integrate` for each.
- Any repository that should be added, removed, or reclassified.
- The single riskiest assumption to validate before any external capability is
  admitted.

Do not treat an upstream README, GitHub stars, claimed performance, or LLM output
as evidence of a trading edge. Do not propose an external runtime or GitHub
Actions worker unless the separate external-integrations architecture has passed
its security and owner gates.
