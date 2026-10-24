# Free-tier workload reduction

Owner decision, October 23, 2026: **keep Free; reduce workload only**.
No paid compute, plan, disk or add-on change is permitted by this decision.

## Bounded changes

1. Council collector admits UTC quarter-hour sweeps before creating a database
   client. Existing five-minute pg_cron windows can still fire, but two of every
   three scheduled calls return an explicit deferral without database reads,
   inference or a false completed-run receipt. Twelve admitted sweeps per hour
   becomes four; pickup latency may increase up to 15 minutes.
2. Candidate scans project only metadata needed by the existing selector, not
   full JSON feature packets for up to 5,000 recent observations every sweep.
   The exact full frozen row is loaded by ID and market only for a selected,
   unscored observation. Identity/read failure blocks before inference and keeps
   that observation in the unscored count. Concurrency is two rather than six.
3. Council evaluation is scheduled at 23:30 UTC weekdays, avoiding weekend
   full-history recomputation. All individual forecasts/labels are retained;
   manual authenticated measurement remains available. This is cadence, not a
   relaxation of maturity or inference gates.
4. Fixed and mined formula evaluation share overlapping market/horizon label
   reads. Fixed all-scored and mined entry-candidate-long populations are still
   distinct, with unchanged declaration boundaries and missingness handling.
   The unused all-market/horizon retention map is removed. In the composed
   fixture, five reads replace eight, with identical expected populations.
5. Settings explains the Free collection profile, two lanes and potential lag.

No models, prompts, scores, daily cap, financial records, safety/trading cadence,
credentials or live settings changed. No synthetic or real inference was run
as verification. Worker supervision is unchanged; existing idle polling already
waits 60 seconds, so it was not mistaken for a five-second idle loop.

## Verification and limits

- Full suite: **4,400 passed / eight skipped / zero failed**; TypeScript and
  staged secret scan passed. Composed tests cover both markets, metadata-only
  idle sweeps, full admitted packets, at most two lanes, failed hydration,
  deferral before client creation, auth before deferral and unchanged cohorts.
- Runtime `cc0e6b68` is pushed to remote main. Deployment and recovery are
  checked independently; do not infer database recovery from local tests.
- Administrative schedule/session reads could not complete (statement timeout
  or connection timeout). No physical pg_cron edits, cancelled sessions,
  restarted database or exact workload culprit are claimed.
- The sampled last-30-minute Postgres logs contained 90 entries and no matching
  out-of-memory/statement-timeout/background-worker text. That limited negative
  sample does not negate the dashboard's SEVERE commitment or failed live reads.
- Reduced code-level reads are proven by fixtures. Actual runtime CPU, I/O
  balance, throughput and natural collection remain to be measured after
  service recovery. An all-features/always-fast Free-tier guarantee is not made.
- Database storage is still a separate Free-quota concern: reducing read work
  does not shrink the stored history. No records were deleted or archived.
