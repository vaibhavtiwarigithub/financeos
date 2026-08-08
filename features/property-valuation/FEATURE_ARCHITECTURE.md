# Property Valuation Evidence

Status (2026-08-08): **Stage 1 schema is shipped, but collection is disabled.**
The previous pre-download `NO_SCOPE` guard remains valid but is no longer enough:
both county collectors are stopped before credentials, scopes, or downloads until
their individual machine-use contracts are verified.

Source-audit correction (2026-08-08): the claimed public/free Phoenix R102
sales source is now **licence-unverified**. Maricopa's official data-sales
catalogue lists Sales Affidavits as a paid product. No new feed use, expansion,
or free-availability claim is authorized until the cited ArcGIS attachment's
publisher, licence, and machine-use permission are recorded. See
`features/property-address-and-carrying-costs/SOURCE_CAPABILITY_AUDIT.md`.

Parent: `features/property-decision-workspace/FEATURE_ARCHITECTURE.md`

There is no AVM, repeat-sales index, hedonic model, comparable-sale engine, or
parcel value claim in Stage 1. The word `valuation` names the user problem; the
current product surface is an evidence ledger.

## 1. Product Boundary

Property evidence remains inside the Property workspace. It cannot affect a
security score, research eligibility, sizing, order, exit, strategy promotion,
or broker call. It never initiates a property or financing transaction.

The owner approved two different evidence tiers because the underlying law and
data differ:

| Market | Stage 1 capability | Explicitly unavailable |
|---|---|---|
| Phoenix | Recorded deed/transfer observations for owner-selected ZIPs | Active AVM or parcel value range |
| Austin | FHFA metro trend plus TCAD county appraised/assessed reference for owner-selected parcels | Public comparable sales or market-price estimate |
| Bengaluru | No parcel source in this feature | Any substituted US evidence |

## 2. Why Phoenix And Austin Differ

### Phoenix

This design previously treated a cited ArcGIS ZIP as a public R102 Sales
Affidavits source. That assertion is not yet source-verified: Maricopa's
official data-sales catalogue lists Sales Affidavits as a paid product. No
production collection may rely on that attachment until its legal and technical
status is resolved. If approved, its columns would include parcel number, month-level
sale date, reported price, deed number/date/status/type, property class, situs
fields, parties, finance fields, assessor quality codes, and personal-property
flags.

Stage 1 reads only the fields needed for identity, quality filtering, ZIP scope,
and the recorded transfer. It never reads or stores grantor/grantee names,
mailing addresses, or owner fields. Situs addresses are not persisted or hashed.

The file is a latest-transfer snapshot, not transaction history. A changed row
can be a correction rather than a new transaction. Therefore:

- event identity is HMAC(parcel) + deed number + deed date;
- each source release remains a separate immutable observation;
- corrections are preserved rather than overwritten;
- later repeat-sale work must collapse reviewed deed identities, not diff rows
  and assume every change is a sale.

Official references:

- `https://www.arcgis.com/sharing/rest/content/items/f3484c72a938497286adc4e5de7e9963?f=pjson`
- `https://www.arcgis.com/sharing/rest/content/items/f3484c72a938497286adc4e5de7e9963/data`
- `https://www.mcassessor.maricopa.gov/file/data_sales/R102_Sales%20Affidavit_Layout_ST42025.pdf`

### Austin

Texas does not provide a public individual-sale-price feed suitable for
comparable-sales modeling. Texas Tax Code 22.27 protects voluntarily disclosed
sale-price information held under confidentiality, and Government Code 552.149
protects related private-entity data held by appraisal authorities.

TCAD does publish certified appraisal exports. They contain distinct `market`,
`appraised`, and `assessed` fields. Kairos stores the exact county terminology;
it does not collapse those fields into a sale price.

Austin can display:

1. FHFA Austin metro HPI trend already collected by Property Markets.
2. TCAD county appraised and assessed references for a selected parcel.
3. The tax year and source release.

The UI must always state: **County appraisal reference, not a market price.**
No Texas AVM may be trained on county assessments, because that would fit one
model to another model and falsely present the result as market evidence.

Official references:

- `https://traviscad.org/publicinformation/`
- current certified appraisal export linked by that page;
- official export layout ZIP linked by that page.

## 3. Source And Licence Boundary

Both sources are approved only for the current owner's private,
non-commercial decision support. No open-data or redistribution licence is
asserted.

Maricopa has separate commercial-purpose request rules and fees. TCAD's public
download page does not grant a commercial redistribution licence. Any future
commercialisation, redistribution, or multi-user product must stop these feeds
until a new declared-use, fee, permission, and legal review is completed.

County data carries no accuracy guarantee. Recorded transfers are evidence, not
automatically arm's-length comparable sales. County appraisals are tax-system
model outputs, not independent appraisals or expected sale prices.

## 4. Privacy Contract

The bulk worker receives the same 32-byte Property encryption master through a
GitHub Actions secret. It derives domain-separated HMAC-SHA256 lookup keys:

```text
HMAC(master, "property:parcel:v1\0" + normalizedParcelId)
HMAC(master, "property:sale-event:v1\0" + parcelKey + deedIdentity)
```

Plain SHA-256 is forbidden because parcel IDs and addresses are enumerable.
Raw parcel/account IDs are accepted only by an owner-gated server route and are
converted before persistence. Parcel HMACs are not returned to the browser.

The bulk worker does not persist or log:

- plaintext parcel/account identifiers;
- owner, grantor, or grantee names;
- mailing or situs addresses;
- raw source archives;
- full input rows.

## 5. Bounded Collection

Large county archives never enter a Vercel request. The monthly
`.github/workflows/property-evidence.yml` worker runs on an ephemeral GitHub
Actions runner.

Safety properties:

1. It queries active scopes before any download. No scope means no provider call.
2. Phoenix persists only selected five-digit ZIPs.
3. Austin persists only selected HMAC parcel IDs.
4. Raw archives live only in a temporary directory and are never artifacts or
   caches.
5. GitHub actions are pinned to commit SHAs with `contents: read` only.
6. Maricopa requires the exact audited 44-column R102 header and fails closed on
   schema drift.
7. TCAD uses the smaller certified fixed-width export, not the multi-gigabyte
   special JSON export, and follows the official layout positions.
8. Every run records source hash, release ID, scope fingerprint, rows seen,
   selected rows, actual inserted rows, and rejection counts.
9. No row-level source content is written to logs.

The service-role secret is still broad. It is accepted only because FinanceOS
already uses it in a private repository action and all target tables are
server-only. A future multi-user product must replace it with a narrowly scoped
ingestion service or database role before activation.

## 6. Data Model

| Table | Mutability | Purpose |
|---|---|---|
| `property_valuation_scopes` | Mutable configuration | Phoenix ZIP or Austin HMAC parcel scopes |
| `property_bulk_snapshots` | Append-only | Source release, file/scope fingerprints, normalization counts |
| `property_bulk_snapshot_events` | Append-only | Write started/completed/failed ledger with actual rows |
| `property_parcel_snapshots` | Append-only | TCAD county references and selected parcel attributes per release |
| `property_sales` | Append-only | Maricopa deed-linked transfer observations per release |

Append-only means UPDATE, DELETE, and TRUNCATE are blocked by grants and
triggers. RLS is enabled and browser grants are revoked. Owner APIs use the
server-side service client only after the existing owner gate succeeds.

The sale uniqueness key includes source, deed-based event HMAC, and source
snapshot. This deliberately retains a correction in a later release. Current
state is derived by a view/query with documented precedence; evidence is never
rewritten.

TCAD releases must preserve tax year and release class. Supplemental rows do not
overwrite certified or preliminary rows. Display precedence is latest valid
supplement, then certified, then preliminary, while every observation remains.

## 7. UI Contract

`/property/valuation` shows evidence state and owner scope controls.

Phoenix:

- selected ZIP scopes;
- source status, last snapshot, actual row count, and errors;
- explicit `NO AVM`, `NO MARKET-PRICE ESTIMATE`, and
  `NO PARCEL VALUE RANGE` labels.

Austin:

- selected private parcel scope;
- latest county appraised/assessed values with tax year;
- FHFA metro trend chart;
- persistent statement that county values are tax references, not sale prices.

Zero rows, no configured scope, provider failure, and unavailable capability are
four different states and must never share copy.

## 8. Learning And Later Stages

Stage 1 makes no prediction. It only accumulates auditable source snapshots.

### Phoenix Stage 2: repeat-sale ZIP index

Blocked until at least two dated source snapshots exist and reviewed deed
identity creates genuine same-parcel repeat transactions. Before activation it
requires:

- correction/retraction handling;
- arm's-length quality policy using deed status and assessor codes;
- minimum event and ZIP sample floors;
- temporal validation with no future release leakage;
- a declared benchmark and error metric.

### Phoenix Stage 3: hedonic interval

Blocked until Stage 2 is calibrated. It may use permitted parcel attributes and
must output an interval, not a point. It requires temporal holdout testing,
out-of-sample error by ZIP and property type, and at least ten matured outcomes
before any calibration rate is shown.

### Phoenix Stage 4: owner parcel interpolation

Blocked until Stage 3 passes. It inherits the ZIP model's measured error and must
be labelled as interpolation, not an independent appraisal.

### Austin

There is no later AVM stage under the current source contract. New public,
licensed arm's-length sales evidence would require a new architecture decision.

## 9. Go/No-Go Gates

Stage 1 may run only when:

- both database migrations are applied and verified;
- Vercel and GitHub use the identical Property encryption master;
- the owner has configured a bounded ZIP or parcel scope;
- the source page, schema/layout, licence posture, and file size still match the
  audited contract;
- parser self-check, TypeScript, tests, and production build pass;
- production RLS, grants, append-only triggers, and advisor results are clean.

No later stage is enabled merely because its code could be written. Evidence,
sample size, and calibration gates are product behavior, not implementation
delay.
