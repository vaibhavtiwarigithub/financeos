# Review Prompt: Deep Candidate Capability Audit

Review `features/external-research-integrations/DEEP_CANDIDATE_CAPABILITY_AUDIT.md`
against the current Kairos codebase and architecture documents. This is a
design-only review. Do not write implementation code.

Read first:

1. `AGENTS.md`, `WORK_LOG.md`, `PRD.md`, and `CLAUDE.md`.
2. `docs/arch/09-learning-loop.md`, `docs/arch/04-database-schema.md`, and the
   Performance Truth Layer documentation.
3. `features/data-source-policy/FEATURE_ARCHITECTURE.md` and the Evidence
   Router implementation/contracts.
4. `features/external-research-integrations/FEATURE_ARCHITECTURE.md`,
   `REPOSITORY_CAPABILITY_CATALOG.md`, and
   `VIBE_TRADING_CAPABILITY_DEEP_DIVE.md`.

Evaluate, most severe first:

1. Does the document overstate any repository capability, license or security
   boundary? Identify claims needing a source-level or license correction.
2. Does any proposed feature bypass or duplicate the Evidence Router,
   Performance Truth Layer, `strategy_evaluations`, benchmark-alpha, learner
   validation or per-market controls?
3. Can Qlib-inspired experiment lineage be append-only, reproducible,
   market/currency-local, and resistant to data leakage or backtest overfit?
4. Does the Vibe lifecycle/counterfactual/Pine roadmap retain deterministic
   no-LLM money-path and owner-approval boundaries?
5. Are TA-Lib, ML4T, FinGPT, FinRL, OpenBB, QuantDinger and Ghostfolio decisions
   conservative enough for real accounts and their licenses?
6. Is sequencing correct while Router Phase 4 has not cut over? Recommend a
   safer order if needed.

For each issue: severity, exact section, concrete failure scenario, minimal
design correction. Then provide sound decisions and a final approve,
approve-with-changes, or reject verdict. Do not authorize imports, dependencies,
code copying, provider activation, broker actions, migrations or deployment.
