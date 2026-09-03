# Claude Code Handoff: Complete Kairos Property End to End

You are the Architect + Builder + Adversarial Reviewer for the remaining Kairos Property work in FinanceOS.

Repository:
`C:\Users\vaibh\OneDrive\Documents\Startup\FinanceOS`

Read first:

1. `AGENTS.md`
2. `WORK_LOG.md`
3. `features/property-decision-workspace/FEATURE_ARCHITECTURE.md`
4. `docs/arch/00-index.md`
5. `docs/arch/02-tech-stack.md`
6. `docs/arch/04-database-schema.md`
7. `docs/arch/05-crons-and-scheduling.md`
8. `docs/arch/08-risk-and-safety.md`
9. `PROJECT_DECISIONS.md` (especially the Property workspace decision)

## User Objective

Finish every appropriate Property workspace phase, including UI/charts, encrypted owner data, deterministic financing and opportunity scenarios, official/free source ingestion, scheduled collection, forecast-versus-outcome learning, documentation, migration, deployment, and production verification.

Use verified official sources and free APIs where practical. Do not add random GitHub projects as production dependencies. External repositories may be used only after license, maintenance, security, data provenance, and runtime isolation review. Prefer small native adapters to large scraping frameworks.

The Property workspace must remain isolated from Kairos Investing and must never affect securities scoring, eligibility, position sizing, orders, or the money path.

## Current Git State

Current local HEAD is `277213af` (`feat: complete property workspace UI`). Earlier Property commits are:

- `0ae7a867` Property P0 shell/schema
- `5d093b3a` inactive property evidence contracts
- `6dddd7a8` Investing -> Property switch
- `8d0e3820` stable workspace-switch placement
- `277213af` expanded Property UI

The worktree is dirty. There are unrelated user/agent changes. Do not revert or include unrelated files. In particular, avoid `.claude/worktrees/**`, unrelated `WORK_LOG.md` edits, `tests/paper-performance-truth.test.ts`, strategy-template work, `output/`, and `tmp/` unless independently proven necessary for this task.

## Implemented and Committed

- Property workspace shell and route family.
- Workspace switch between Investing and Property.
- Initial Property schema/evidence contracts.
- Expanded UI pages/components from commit `277213af`:
  - My Properties
  - Opportunities
  - Financing
  - Forecasts/Learning
  - responsive Property navigation

Review this commit cold. Do not assume it is correct merely because it is committed.

## Implemented Locally but NOT Yet Completed or Verified

These files exist as uncommitted work and need review, integration, tests, and correction:

- `lib/property/crypto.ts`
  - server-only AES-256-GCM encryption using `PROPERTY_DATA_ENCRYPTION_KEY`
  - fail-closed when no valid 32-byte key exists
- `lib/property/scenarios.ts`
  - deterministic mortgage/amortization, refinance, HELOC/LAP, rental, buy-vs-rent, and downside scenarios
- `lib/property/forecast.ts`
  - simple drift/uncertainty shadow forecast
- `lib/property/sources.ts`
  - FHFA HPI, FRED 30-year mortgage, and BLS LAUS adapters
- `lib/property/contracts.ts`
- `lib/property/registry.ts`
- Property APIs under `app/api/property/`:
  - `assets`
  - `imports`
  - `overview`
  - `collect`
  - `scenarios`
  - `financing`
  - `forecasts`
- `components/property/MyPropertiesWorkspace.tsx`
  - partially wired to the encrypted assets API
- `components/property/PropertyMarketData.tsx`
- `app/property/markets/page.tsx`
- `tests/property-scenarios.test.ts`
- `tests/property-forecast.test.ts`
- `supabase/migrations/20260807120000_property_private_scenarios_and_learning.sql`

The focused scenario tests previously passed (14 tests), but the full tree has not been typechecked or built after integration.

## NOT Completed

Do not report this feature complete until all applicable items below are done:

1. Review and correct every uncommitted Property file.
2. Run TypeScript and resolve all errors caused by Property work.
3. Run focused tests and the full relevant test suite.
4. Review the migration for idempotency, RLS, grants, append-only behavior, indexes, cron safety, ownership isolation, and compatibility with already-applied Property migrations.
5. Apply the new migration to production Supabase project `dionkikgdmlaotvtbnfr` only after validation.
6. Verify migration history, table definitions, RLS enablement/policies, triggers, grants, source registry rows, and cron rows from production.
7. Run Supabase security and performance advisors; fix Property findings.
8. Configure `PROPERTY_DATA_ENCRYPTION_KEY` in the correct FinanceOS Vercel project without logging or committing the key. Confirm the FinanceOS account/repo before changing external state.
9. Wire remaining UI to APIs:
   - Opportunities must save/reload deterministic scenarios rather than being only local state.
   - Financing must persist encrypted financing details and run refinance/HELOC/LAP scenarios.
   - Forecasts/Learning must display persisted forecasts and matured forecast outcomes.
   - Data Sources must show real, market-specific source state, latest run, observations, failures, and next schedule.
   - Markets must render real persisted observations and clear unavailable/empty/error states.
10. Add charts appropriate to available data:
   - HPI trend and change
   - mortgage-rate history
   - unemployment trend
   - forecast range versus actual outcome once mature
   - scenario cash flow/equity/downside outputs where useful
11. Ensure the top workspace switch remains in the same stable location in both Investing and Property views.
12. Verify desktop and mobile with Playwright screenshots. Check no overflow, overlap, blank charts, hydration errors, or broken navigation.
13. Start the local app and provide the working URL.
14. Update authoritative docs and Mermaid diagrams:
   - `features/property-decision-workspace/FEATURE_ARCHITECTURE.md`
   - `docs/arch/02-tech-stack.md`
   - `docs/arch/04-database-schema.md`
   - `docs/arch/05-crons-and-scheduling.md`
   - `docs/arch/06-api-reference.md` or the actual API chapter
   - `docs/arch/08-risk-and-safety.md`
   - `SYSTEM_OVERVIEW.md` / `ARCHITECTURE.md` only where their ownership rules require it
   - `PROJECT_DECISIONS.md`
   - Property `IMPLEMENTATION_RESULT.md`
15. Commit only Property files, push FinanceOS to `vaibhavtiwarigithub/financeos`, deploy to the correct Vercel project, and verify production routes.

## Source Decisions Already Researched

Use these decisions unless live verification disproves them:

### GO: native official adapters

- FHFA HPI (US market/metro home prices)
  - master JSON: `https://www.fhfa.gov/hpi/download/monthly/hpi_master.json`
  - metro CSV: `https://www.fhfa.gov/hpi/download/quarterly_datasets/hpi_at_metro.csv`
  - required attribution: `This product uses FHFA Data but is neither endorsed nor certified by FHFA.`
- FRED `MORTGAGE30US` for US mortgage-rate history; public graph CSV can work keyless.
- BLS LAUS for metro unemployment; keyless public API is sufficient for bounded usage.
- HUD FMR only after a free token is configured and its limits are respected.
- Census ACS only after its current key requirement is satisfied.

### Bounded/manual/deferred

- Redfin aggregate Data Center files: allowed only in a bounded external worker. Do not download 90-600 MB datasets inside Vercel requests. Never scrape Redfin listings.
- RBI: bounded official export/manual import until a stable, permission-compatible API is proven.
- Bengaluru owner/property inputs: owner-directed encrypted imports only at this stage.
- NHB: defer automation/storage unless reproduction/storage terms are cleared.
- TCAD/Maricopa public records: later and privacy-minimized; discard owner names.

### KILL as production runtime dependencies

Do not install or call these merely to claim coverage: DealLens, RealVest, `fred-mcp`, `rhud`, `api-evangelist/redfin`, HomeHarvest, or generic listing scrapers. Their code, license, maintenance, or provenance does not improve the security/reliability boundary over native official adapters.

## Known Risks to Inspect Before Migration

1. Observation uniqueness currently includes nullable `source_version`. PostgreSQL NULL uniqueness can allow duplicate logical rows. Use a non-null revision/version contract or an expression index; do not leave silent duplication.
2. Revision handling must permit a revised observation for the same `as_of` date without mutating the earlier row. A collector that filters `as_of <= latest` can accidentally suppress revisions.
3. FHFA data should not be fetched repeatedly once per market in the same run. Cache one bounded fetch per invocation.
4. Forecasts are decision-support shadows, not promises or money-path inputs. Enforce this in schema/API/UI copy.
5. Do not store plaintext addresses, mortgage account numbers, owner names, free-form uploaded documents, or precise identity-bearing records.
6. Service-role use must remain server-only. Owner routes must verify the configured owner identity and never trust caller-supplied `owner_id`.
7. Cron endpoints need the established cron authentication pattern and bounded execution.
8. Source failures must be visible and fail-soft; never fabricate observations or forecasts.
9. Austin, Phoenix, and Bengaluru must show market-local coverage honestly. Do not substitute US values into Bengaluru cards.

## Product Requirements

- Markets: Austin, Phoenix, Bengaluru initially.
- Decisions: buy, sell, hold, rent, refinance, HELOC, and India loan-against-property.
- Owner can add properties without exposing exact addresses; use aliases and coarse geography.
- Trend charts must clearly distinguish observed data, forecasts, and unavailable data.
- Forecast learning compares prediction with subsequently observed values and records error; it does not automatically make financial decisions.
- No LLM is required for scenario math or forecasts. LLMs may explain deterministic outputs later, never alter the calculations.
- Property data and agents cannot influence securities agents or trades.
- Scheduled collection should be monthly/weekly according to source cadence, not waste calls by polling static data daily.

## Required Completion Report

Return:

1. Findings ranked by severity and exactly how each was fixed.
2. Implemented files/features.
3. Tests/typecheck/build results.
4. Production Supabase migration verification and advisor results.
5. Vercel deployment URL and route smoke-test results.
6. Source coverage by Austin/Phoenix/Bengaluru, including what remains honestly unavailable and why.
7. A short list of genuinely deferred items. Do not label an unbuilt phase complete.

Do not touch FinNudge. Do not expose secrets. Do not enable any Property output on the investing money path.
