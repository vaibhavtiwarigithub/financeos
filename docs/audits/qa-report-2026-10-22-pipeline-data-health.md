# Pipeline data-health repair verification

## Release and scope

Runtime commit `57ba4a55dad2dbd894a5ce0fd9b190a39dbdb6ab` was pushed to main.
Vercel deployment `dpl_2PoK6e4aKKRGmnf8S4got4Pn2kFX` is READY with aliases
assigned. The subsequent completion record changes documentation only.

Repairs reuse existing source adapters, date conventions and scheduler:

- Leveraged paper quote reads try the existing validated Robinhood bid/ask
  reader if Twelve Data is absent, failed or stale. Venue-age and skew checks
  stay unchanged. Missing session high/low remains null; a point quote does not
  prove no stop touch occurred during an unobserved interval.
- Crypto source selection requires 51 completed daily candles through the
  expected UTC date. Obsolete histories cannot block fallback. Exact Kraken
  base/USD requests replace the accidental three-symbol fallback restriction.
  No fuzzy ticker or stablecoin-pair conversion is introduced. Cross-venue
  identity for discovered symbols is not proof of execution eligibility.
- Post-close price prewarm passes its exact required session into the existing
  candle resolver, so the first merely recent source cannot stop fallback.
- Migration `20261022154455_post_nav_benchmark_retry` updates the existing India
  retry to 11:35 UTC / 17:05 IST, after the 11:15 EOD NAV producer. The initial
  10:15 pass remains. Job identity, prior schedule and local slot are checked;
  no extra daily request is added.

## Tests

- Full regression: **4,163 passed, eight skipped, zero failed**. JSON report is
  outside the repository in the owner's temporary directory.
- TypeScript: `npx tsc --noEmit`, exit zero.
- Staged GitGuardian secret scan: no secrets found.
- Targeted tests cover stale crypto fallback and exact-pair requests, unknown
  pairs, stale broker rejection, preserved broker event time and null ranges,
  required-session candle fallback including final AV rejection, and the guarded
  schedule correction. An old exact-options assertion was updated to require
  both forceRefresh and the actual market-session boundary.
- Security advisor categories remained unchanged before/after the schedule-only
  migration. Existing advisor findings are not claimed resolved by this repair.

## Production evidence

- India benchmark refresh after EOD NAV completed: **16 ok**, four legitimately
  insufficient and 20 missing live-book histories. Its prior 12 stale paper rows
  cleared. All four enabled benchmark sources reached the expected date.
- Bounded US price-only refresh: HTTP 200, **159 symbols, zero failures**;
  `price-prewarm-incomplete:us` recovered through the route's ordinary check.
- Bounded crypto collector: HTTP 200, **11/12** selected targets fresh versus
  9/12 before. CC and LIT obtain current Kraken history. The universe run stays
  `partial` because CASHCAT has no usable source; it is not relabeled healthy.
- The existing local Claude/Codex supervisors had stopped. Restarted their
  saved hidden launchers without reading private config or queuing extra work.
  Both submitted forecasts, and 92 US council runs subsequently completed.
  One India run remains partial; this is not universal provider availability.
- The natural SQQQ paper check at 15:40 UTC succeeded. The health checker
  resolved yesterday's failed-run incident using later same-market recovery.
  This success preceded the new fallback deployment: it is current health,
  **not proof of an after-close Robinhood fallback**. The latter still needs a
  natural failed-primary/fresh-broker observation; no trade route was manually
  run to manufacture that proof.
- Authenticated crypto dashboard smoke: one `Crypto Markets` H1, no broken
  images, no page overflow, no application-error text or captured console errors.
  Public SEO schema/canonical requirements are not applicable to this private
  authenticated workspace. Anonymous crypto collector GET and price-prewarm
  POST return 401; anonymous dashboard navigation redirects to authentication.

## Still unresolved or intentionally unavailable

- Kite requires owner re-login; paper research is independent of that session.
- The latest US discovery pass reported real sentiment for 14/21 applicable
  names. Its provider chain still lacks enough usable evidence for seven names.
  No made-up sentiment or forced alert resolution was applied.
- CASHCAT public quote/history remains unavailable. Do not remove it merely to
  make coverage green or claim another token with the same ticker is equivalent.
- Unrecorded historical live account balances cannot be reconstructed honestly.
  Immature horizons and missing snapshots remain unavailable, not forward-filled.
- India council/deterministic disagreement remains diagnostic information; the
  council is shadow-only. No promise of better returns or live protection.

No live enablement, model roster, score weight/formula, stop/target policy, risk
cap or manual broker order was changed. The crypto refresh writes ordinary
research evidence/signals only; no paper/live trade route was manually invoked.
