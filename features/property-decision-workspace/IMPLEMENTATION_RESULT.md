# Kairos Property — implementation result

Date: 2026-08-07 · Production project `dionkikgdmlaotvtbnfr`
Status: **P2–P4 schema applied and verified. UI persistence and charts landed.
Deployment verification, visual testing, and the Vercel encryption key are NOT
done. This feature is not complete.**

---

## 1. Findings, by severity, and how each was fixed

Every one of these was found by reviewing the work rather than by a test
failing, and every fix below was verified against the live database.

### CRITICAL — append-only was breakable by TRUNCATE
Five evidence tables were defended by **BEFORE ROW** triggers only. A row trigger
**does not fire on TRUNCATE**, and `service_role` still held the grant, so every
"append-only" property ledger could be erased with every stated guarantee
apparently intact. This is the identical hole closed on 2026-08-01 for the
exogenous-risk tables (`20260801160000`), reintroduced.

*Fix:* statement-level `BEFORE TRUNCATE` triggers on `property_scenarios`,
`property_forecasts`, `property_forecast_outcomes`,
`property_market_observations`, `property_decision_journal`, plus
`REVOKE UPDATE, DELETE, TRUNCATE ... FROM service_role` so grants and triggers
are two independent barriers. **Verified live:** TRUNCATE is rejected with
`property_market_observations is append-only and cannot be truncated`, and
`service_role` holds neither TRUNCATE nor DELETE on any of the five.

### HIGH — the migration could only ever be applied once
`CREATE TRIGGER` has no `IF NOT EXISTS` in any Postgres version, so a re-run
would abort. A migration that cannot be re-applied is not idempotent and will
break any replay or environment rebuild.

*Fix:* drop-then-create inside a `DO` loop. **Verified** by re-running the whole
trigger/grant block: succeeds, five TRUNCATE triggers still present.

### HIGH — silent logical duplication in observations
`property_market_observations`' uniqueness key includes the **nullable**
`source_version`. Postgres treats NULLs as distinct, so two rows with identical
source, geography, metric, `as_of` and `revision_state` and a NULL version would
**both** insert.

*Fix:* replaced with a unique index using **NULLS NOT DISTINCT**. Safe to do
without a backfill because the table held zero rows at the time.

### HIGH — revisions were silently suppressed
Every adapter filtered `as_of <= since`. A source republishing a corrected value
for an existing period could therefore never be ingested, and the
`revision_state` column and the revision-aware uniqueness key could never fire.
The schema modelled revisions; the collector made them unreachable.

*Fix:* `keepObservation()` always admits a `revised` observation and applies the
`since` lower bound only to `initial` ones. The unique index remains the thing
that prevents a true duplicate. Unit-tested in `tests/property-ingestion.test.ts`.

### MEDIUM — national files re-downloaded once per market
FHFA's multi-megabyte master JSON and FRED's full history were fetched **per
market** with `cache: "no-store"` explicitly defeating Next's caching — nine
upstream calls for a three-market run.

*Fix:* a per-invocation cache in `lib/property/sources.ts`, cleared at the start
of every run. Deliberately **not** TTL-based: a TTL would serve a stale national
file into a later scheduled run. **Measured 9 → 4**, and 4 is correct because BLS
needs one request per metro.

### MEDIUM — dishonest market coverage reporting
Bengaluru recorded `success, 0 rows` for US-only sources, making a structural
coverage gap indistinguishable from a quiet collection day.

*Fix:* adapters declare `supportsMarket()`; the collector records
`not_applicable` with a reason and `request_count = 0`; the `outcome` CHECK was
extended to allow it. The Markets page states the gap in words instead of showing
three empty charts.

### MEDIUM — provider-call accounting overstated usage
`property_source_runs.request_count` recorded `1` per adapter call even when the
run cache served the payload with no network request — inflating the very ledger
used to justify the collection cadence.

*Fix:* records the actual number of upstream fetches attributable to that run.

### MEDIUM — duplicated scenario math in the UI
`OpportunitiesWorkspace` carried its own `monthlyPayment()` and `metrics()`
alongside the server's `evaluateRentalEconomics()`. Two implementations of one
formula drift, and then the displayed number and the stored number disagree with
no way to tell which is right.

*Fix:* the component renders exactly what the engine computed and stored. The one
remaining local calculation (deriving annual debt service from the typed rate and
down payment) imports the same `calculateMortgage()` the server uses.

### MEDIUM — a 5xx rendered as "no data"
`PropertyMarketData` never checked `response.ok`, so an outage and an empty
market looked identical.

*Fix:* explicit load-error state that says it is a load failure. Same guard added
to the Opportunities, Financing and Forecasts workspaces.

### LOW — 2,889 mortgage points plotted raw
*Fix:* 1Y/5Y/Max window plus downsampling to 220 points, always retaining the
true latest observation so the "as of" line cannot disagree with the chart.

---

## 2. What was implemented

- **Schema**: six private/evidence tables, RLS on, browser grants revoked,
  encrypted payload columns, append-only enforced by trigger **and** grant.
- **Ingestion**: FHFA HPI, FRED `MORTGAGE30US`, BLS LAUS as small native
  adapters; per-invocation cache; revision-aware admission; honest per-market
  outcomes.
- **Crons**: `kairos-property-collect` (Sun 10:00 UTC) and
  `kairos-property-forecast` (Sun 10:30 UTC). Weekly because these sources
  publish monthly/quarterly.
- **Encryption**: AES-256-GCM, versioned, fail-closed (`lib/property/crypto.ts`).
- **Opportunities**: scenarios persist through the server engine; DSCR and
  decision state surfaced; USD/INR never combined.
- **Financing**: accounts persist; refinance and rate-shock use the shared
  engine; cumulative-benefit chart with a breakeven marker plus a stacked
  principal/interest amortization curve.
- **Markets**: windowed, downsampled charts; observed vs shadow-forecast drawn as
  distinct series with a band; honest empty, error and not-applicable states;
  source attribution rendered.
- **Forecasts & learning**: new `GET /api/property/forecasts` returning forecasts
  joined with matured outcomes; forecast-range-versus-actual chart; calibration
  table that **withholds any rate below 10 matured outcomes** while always
  showing `n` (`lib/property/calibration.ts`, 8 unit tests).

## 3. Gates

`npx tsc --noEmit` clean. `npx vitest run` **1688 passed / 7 skipped**.
`npm run build` clean.

Two tests failed on two separate runs and passed on a clean re-run both times.
The flaky pair has not been identified. It is recorded here rather than ignored.

## 4. Production verification

| check | result |
|---|---|
| 11 property tables present | yes |
| RLS enabled on all | yes |
| `service_role` TRUNCATE/DELETE on the 5 evidence tables | **none** |
| TRUNCATE actually blocked | yes, by trigger |
| `NULLS NOT DISTINCT` on the observation identity index | yes |
| Both crons registered | yes, Sundays 10:00 / 10:30 UTC |
| Supabase security advisors, Property findings | none above INFO; the INFO `rls_enabled_no_policy` entries are deliberate (server-only tables, browser grants revoked = deny-all) |

**Ingested:** Austin and Phoenix each hold FHFA HPI (196 quarters from 1977),
FRED `MORTGAGE30US` (2,889 weeks from 1971) and BLS LAUS (65 months).
**Bengaluru holds zero** rather than borrowing US values.

## 5. Source coverage, honestly

| market | price index | mortgage rate | unemployment | note |
|---|---|---|---|---|
| Austin | FHFA HPI ✅ | FRED ✅ | BLS LAUS ✅ | full US pack |
| Phoenix | FHFA HPI ✅ | FRED ✅ | BLS LAUS ✅ | full US pack |
| Bengaluru | ❌ | ❌ | ❌ | all three active sources are US-only; recorded `not_applicable`, never substituted |

Bengaluru requires RBI/NHB bounded official export or owner-directed encrypted
import. Both remain `contract_pending`; neither is built.
Census ACS and HUD FMR are `contract_pending` pending a key/token.

## 6. Genuinely deferred — not complete

1. **`PROPERTY_DATA_ENCRYPTION_KEY` is not set in Vercel.** Owner action. It must
   be **identical** to the local value because both environments write the same
   Supabase project; a mismatch makes stored payloads permanently undecryptable.
2. **No Playwright or visual verification.** The pages are auth-gated and no
   desktop/mobile screenshot pass was run. Responsive classes are reused from the
   existing shell but are unverified visually.
3. **No production deployment smoke test.**
4. **My Properties and Imports** are not part of this pass.
5. **Bengaluru data** — no India source is implemented.
6. **`rent_index`** is forecast-capable in code but no adapter produces it, so it
   will never populate.
7. **Open design question, undecided:** `MORTGAGE30US` is a **national** series
   stored per market, so 2,889 identical rows exist for Austin and again for
   Phoenix. It works, but it duplicates and misrepresents a national series as
   market-local. A cleaner model is one `national` geography that markets
   reference. Left as an owner decision, not silently changed.
