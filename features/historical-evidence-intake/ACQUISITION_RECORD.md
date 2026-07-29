# Historical Evidence Acquisition Record

**Acquired:** 2026-07-29
**Store:** `%USERPROFILE%\.kairos\evidence`
**NSE price normalizer commit:** `da8b9ac1b087920afb3781a81eb9a2bc797a5336`
**NSE price normalizer SHA-256:** `b0981a94761dc4e8dd0c5adc5183b2b6cf0663f99f91ed217c2a29f2f4ed50f5`

The local store is outside the repository and OneDrive. Every current manifest
below was re-read and every bound file was verified against its byte count and
SHA-256 after acquisition.

## Current Datasets

| Dataset | Coverage | Normalized content | Fingerprint |
|---|---|---:|---|
| `nse-bhavcopy-2020-01-01-2026-07-29-v6` | 1,625 exchange files from 1,716 weekdays | 2,981,692 EQ daily bars, corrected UDiFF volume, 842 MB | `213e10adb4c9333a7b55b2a349f7265e840b5e9f4e3134c21a03d18afa68995d` |
| `nse-corporate-actions-2020-01-01-2026-07-29-v5` | 79 monthly responses | 14,016 EQ actions, 6.1 MB | `8f77a60114ba5435a9afbc30ecc7985b9e2fa846ec2cefc862212c6d78500cf2` |
| `sec-fsds-2024q1-2026q1-v5` | 9 quarterly official ZIPs | 1,518,101 primary-statement facts, 808 MB | `146ef98d4e75c203a4d70c4e7b493fe52e2cf9268a37a91d8943195584e88c6f` |
| `fred-alfred-macro-vintages-2026-07-29-v5` | 1991 through acquisition date | 11 configured MacroSentinel series | `c8ac23d465693e9b010f41c29149b0c5e4f8e32134d0bd5263ca82aa029e2c72` |
| `sp500-community-a91ef88fad5a-v5` | 1996 through acquisition date | diagnostic membership fixture | `ec07173954f7baafdb98967f6fd6ca842621e8ccdb89ec99e2658899adf0c4d9` |

Total local evidence-store size after immutable intake iterations: approximately
approximately 5.5 GB after preserving the superseded NSE v5 normalized file.
Older source-schema versions remain preserved for audit but show
`currentNormalizer: false`; experiments must bind an exact current fingerprint.

The v5 NSE price normalizer misspelled the UDiFF `TtlTradgVol` header and wrote
zero volume from the 2024 UDiFF cutover onward. The first local replay exposed
the empty-universe consequence. V6 corrects the header, is a new immutable
dataset, and leaves v5 plus the affected diagnostic run intact for audit.

## Admission Limits

- NSE prices remain raw. The action ledger supports event exclusion and future
  derivation, but adjusted returns must refuse 222 ambiguous or unsupported
  price-affecting actions, principally rights issues.
- The 91 weekday dates without NSE bhavcopy files are retained in the manifest.
  They are expected exchange holidays but remain unreconciled until an official
  exchange-calendar artifact is bound.
- SEC facts are keyed by CIK/accession. The FSDS files do not provide a
  point-in-time ticker mapping.
- SEC replay uses the calendar day after filing as a conservative availability
  date. Dimensional and subsidiary facts are excluded to avoid double counting.
- The SEC loader chooses a preferred XBRL alias only when duplicate metric values
  agree; conflicting aliases are omitted.
- ALFRED vintages are available for `UNRATE`, `PAYEMS`, `GDPC1`, and `CPIAUCSL`.
  Latest-only monthly fallbacks (`RSAFS`, `FEDFUNDS`, `DGORDER`) are marked
  non-PIT and the replay loader refuses them.
- The S&P file is community-maintained, commit-pinned, and diagnostic-only.
- No free source reviewed provides older broad-US prices with delistings,
  corporate actions, and a point-in-time security master. Older promotion-grade
  US tests remain blocked on licensed data.

## GitHub Intake Decisions

| Repository | Useful capability | Decision |
|---|---|---|
| `chartiny/nse-cm-bhavcopy` and `chartiny/nse-sec-bhavdata-full` | MIT mirrors of NSE daily reports | cross-check/fallback only; official NSE archives are primary |
| `jugaad-data/jugaad-data` | mature NSE/RBI downloader patterns | reference only; no runtime Python dependency |
| `hanshof/sp500_constituents` | historical S&P membership | commit-pinned diagnostic fixture |
| `JerBouma/FinanceDatabase` | current symbol and product classification | optional context only; not point-in-time evidence |
| `tilak999/NSE-Data-bank` | broad India history | rejected for intake because no clear license was found |
| `shinathan/polygon.io-stock-database` | broad US database scripts | rejected as a free replacement because useful feeds require paid subscriptions |

No repository code is executed by Kairos. GitHub data is never promoted above its
license, provenance, and point-in-time guarantees.
