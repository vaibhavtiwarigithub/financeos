# Governed Historical Evidence Intake

**Status:** APPROVED for implementation by owner direction on 2026-07-29
**Scope:** offline acquisition, validation, normalization, and historical replay only
**Money-path status:** unreachable; no scorer, trader, monitor, cron, or broker reads this store

## 1. Decision

Kairos will maintain a local, immutable historical-evidence store for deterministic
backtests. It will acquire official bulk data where available, pin any community
artifact to an exact commit, validate and hash every file, quarantine failures, and
feed normalized records only to the existing sealed replay layer.

This is not a universal market-data lake. The useful first scope is:

1. India daily equity prices and point-in-time traded universe from NSE bhavcopy.
2. India historical corporate actions from NSE, required before adjusted-return use.
3. US as-filed fundamentals from SEC quarterly Financial Statement Data Sets.
4. US macro vintages from FRED/ALFRED for as-known regime replay.
5. A diagnostic-only S&P 500 historical-membership fixture for cross-checks.

No free GitHub repository found in the intake review replaces a survivor-bias-free
US security master plus adjusted prices and delisting returns. Kairos must continue
using its existing Massive point-in-time membership/price entitlement for recent US
experiments or purchase licensed data for older promotion-grade US tests.

## 2. Why Local, Not Supabase

The raw SEC archive is gigabytes and India daily files are hundreds of megabytes.
Uploading those rows to Supabase would waste the free database/storage budget and
make local reproducibility depend on network access.

Raw and normalized files live under:

```text
%KAIROS_EVIDENCE_DIR%
  raw/<source>/<version>/...
  normalized/<dataset>/<version>/...
  manifests/<dataset-id>.json
  quarantine/<dataset-id>/...
  catalog.json
```

Default: `%USERPROFILE%\.kairos\evidence`. The store is outside the repository and
outside OneDrive. Only small schemas, acquisition code, tests, and example manifests
are committed.

Supabase receives only the existing immutable experiment identity, dataset
fingerprint, result summary, and (when explicitly materialized) sealed replay packet
metadata. Raw bulk rows never enter a browser or Vercel runtime.

## 3. Source Decisions

| Source | Capability | Authority | Intake decision | Evidence class |
|---|---|---|---|---|
| SEC Financial Statement Data Sets | quarterly ZIPs of primary statements, as filed, 2009+ | SEC official | adopt; prefer over bulk `companyfacts.zip` for historical normalization | promotion-capable after metric tests |
| SEC `companyfacts.zip` | all XBRL company facts, nightly | SEC official | catalog only; do not download by default (1.29 GB compressed and much larger expanded) | capture/reference |
| NSE daily bhavcopy | all daily CM rows, OHLC/volume/trade fields | NSE official | adopt | promotion-capable only with actions and coverage |
| NSE corporate-actions archive | splits, bonuses, dividends and effective dates | NSE official | adopt; adjusted returns refuse without it | promotion-capable after reconciliation |
| FRED/ALFRED | observation vintages and real-time periods | Federal Reserve Bank of St. Louis | adopt exact series used by MacroSentinel | promotion-capable |
| `chartiny/nse-*` | normalized mirrors of NSE reports | community, MIT repo | fallback/probe only; pin commit and cross-check official samples | diagnostic |
| `jugaad-data` | NSE/RBI downloader and caching patterns | community | reference implementation only; do not add Python runtime dependency | reference |
| `hanshof/sp500_constituents` | daily historical S&P membership since 1996 | community, MIT | adopt as a small diagnostic fixture, never as sole promotion universe | diagnostic |
| `FinanceDatabase` | current global symbol/classification catalog | community, MIT | optional display/entity-resolution input only | context |
| TradingView CSV | manually loaded chart bars/indicators | user-licensed manual export | accepted only for named-symbol diagnostics; never proves a PIT universe | diagnostic |
| FNSPID and similar news corpora | historical prices/news | research/community corpus | defer pending license, source, timestamp, and leakage audit | quarantined |

Repository code is never dynamically executed. Data files are downloaded over HTTPS;
community files are pinned to immutable commit URLs. GitHub outages cannot remove
already-hashed local copies.

## 4. Manifest Contract

Each acquisition writes a manifest before normalization:

```ts
interface EvidenceDatasetManifestV1 {
  schemaVersion: "kairos.evidence-dataset.v1";
  datasetId: string;
  sourceId: string;
  sourceAuthority: "official" | "community" | "manual";
  evidenceClass: "promotion_candidate" | "diagnostic" | "reference";
  market: "us" | "india" | "global";
  dataKinds: Array<"ohlcv" | "universe" | "fundamental" | "macro" | "corporate_action">;
  sourceVersion: string;
  retrievedAt: string;
  files: Array<{
    relativePath: string;
    sourceUrl: string;
    sha256: string;
    bytes: number;
    mediaType: string;
  }>;
  coverage: { start: string; end: string; expectedFiles?: number; receivedFiles: number };
  normalization: {
    schemaVersion: string;
    codeGitSha: string;
    codeSha256: string;
    status: "pending" | "valid" | "quarantined";
  };
  limitations: string[];
  datasetFingerprint: string;
}
```

The dataset fingerprint is SHA-256 over canonical manifest fields and ordered file
hashes. A changed upstream file creates a new dataset version; it never mutates an
existing valid version.

## 5. Canonical Records

### Daily bar

`market, exchange, symbol, session_date, open, high, low, close, volume,
turnover, currency, price_basis, source_file_sha256`

Raw exchange prices remain raw. Adjusted prices are a derived dataset with a separate
fingerprint and the exact corporate-action manifest in its lineage.

### Fundamental fact

`cik, accession, symbol_at_filing, form, filed_at, accepted_at, period_start,
period_end, fiscal_year, fiscal_period, taxonomy, tag, unit, value, statement,
source_file_sha256`

Reads use `accepted_at <= as_of`; if the compact SEC data exposes only filing date,
daily replay treats it as available after that session and records the coarser clock.
Amendments are additional accessions, not in-place replacements.

### Macro observation

`series_id, observation_date, realtime_start, realtime_end, value, unit,
frequency, source_file_sha256`

An as-of read selects the row whose real-time interval contains the decision date.
Latest revised values must never be stamped onto historical decisions.

### Corporate action

`market, symbol, action_type, ex_date, record_date, ratio_or_amount, currency,
announced_at, source_file_sha256`

Unsupported or ambiguous actions quarantine the affected symbol/date range. The
normalizer never guesses a split ratio from a price jump.

## 6. Validation and Quarantine

All gates fail closed:

1. HTTPS and allowlisted host.
2. Successful status and non-empty body.
3. SHA-256 and byte count recorded.
4. Expected archive members and headers present.
5. Dates parse and remain inside requested coverage.
6. OHLC invariants: positive prices, `high >= max(open,close)`,
   `low <= min(open,close)`, non-negative volume.
7. One canonical row per source key; conflicting duplicates quarantine.
8. Market/currency contract: US/USD, India/INR.
9. Session coverage report distinguishes exchange holidays from missing files.
10. Corporate-action completeness is required for adjusted-return datasets.
11. Symbol mappings are time-varying; current ticker text is not a permanent ID.
12. No normalized record may have `knowable_at > replay_as_of`.

Quarantined files remain preserved with reasons and hashes but cannot be resolved by
the replay accessor.

## 7. Existing Architecture Integration

This extends, rather than duplicates, current truth layers:

- `lib/replay/packet-assembler.ts` remains the sole raw-to-frozen boundary.
- `lib/replay/sealed-accessor.ts` remains the network-free read boundary.
- `edge_universe_members` remains the persisted PIT universe table.
- `fundamental_facts` remains the live forward-capture ledger.
- `backtest_experiments` remains the immutable experiment identity.

The local resolver emits the existing `RawRecord` contract, extended additively
with first-class `macro` and `corporate_action` item types. It does not add a
second scoring API or a second experiment ledger.

Default resolver order for offline replay:

1. exact immutable local dataset named in the experiment manifest;
2. existing persisted PIT snapshot with matching policy/fingerprint;
3. refuse.

There is no live-provider fallback inside a bound replay.

## 8. Safety Boundary

- No environment switch can make this store affect live scoring.
- No API route exposes raw files.
- No cron downloads or normalizes data in P0.
- No LLM parses, validates, transforms, or selects financial rows.
- Community and manual sources are diagnostic by default.
- A promotion experiment must name the exact dataset fingerprint before the run.
- India and US datasets, currencies, universes, actions, and results remain separate.

## 9. Build Order

1. Manifest, hashing, allowlist, atomic download, quarantine, and catalog CLI.
2. FRED/ALFRED exact-vintage acquisition for the existing MacroSentinel series.
3. SEC quarterly ZIP acquisition and schema validation; selective normalization
   for the experiment universe rather than expanding every fact permanently.
4. NSE official bhavcopy acquisition and normalization.
5. NSE corporate-action acquisition and adjusted-return derivation.
6. Local replay resolver to `RawRecord`, plus sealed-accessor tests.
7. Diagnostic community fixtures pinned to commits.
8. Coverage report; only then run new India and macro PIT diagnostics.

## 10. Acceptance Criteria

- Re-running an acquisition with unchanged bytes is idempotent.
- Changed bytes at the same URL produce a new version or quarantine; never overwrite.
- Interrupted downloads leave no valid manifest.
- Path traversal from ZIP member names is rejected.
- Invalid rows cannot appear in normalized output.
- An as-of macro/fundamental read cannot see later revisions/amendments.
- India adjusted returns refuse when corporate actions are missing.
- A replay bound to a dataset works with network disabled.
- No import changes any current score, signal, paper position, broker proposal, or order.
- Catalog output names coverage, source authority, evidence class, limitations, and
  exact fingerprints without exposing secrets.

## 11. Residual Limitations

1. Free US history older than the existing Massive entitlement remains unsuitable
   for broad promotion-grade, survivor-safe equity tests.
2. SEC statements solve fundamentals, not prices, corporate actions, or delisting returns.
3. NSE bhavcopy gives a point-in-time traded set, not necessarily every temporarily
   suspended but still listed security.
4. Community historical-index files are useful cross-checks, not authoritative truth.
5. Historical news/sentiment remains deferred because publication-time corrections,
   corpus selection, redistribution rights, and prompt-injection surfaces are harder
   than the incremental value currently justifies.

## 12. Implementation Record

Implemented on 2026-07-29. The exact current manifests, fingerprints, coverage,
row counts, and residual exclusions are recorded in `ACQUISITION_RECORD.md`.
Only entries marked `currentNormalizer: true` by the catalog are candidates for
new experiment binding.
