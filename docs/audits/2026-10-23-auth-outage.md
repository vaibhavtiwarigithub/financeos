# Kairos availability incident — October 23, 2026

## What failed

The owner reported `504 MIDDLEWARE_INVOCATION_TIMEOUT`. Cookie-free smoke checks
missed the defect: middleware's cookie-bearing path awaited `auth.getUser()`
without a deadline. Viewer-grant reads and sign-out added more unbounded waits.
Authentication is a mandatory boundary for service-role-rendered pages; simply
allowing a cookie-bearing request through would expose private data.

## Resource evidence and limits

The owner supplied an Infrastructure chart showing a Disk I/O balance depletion
from 98% to 0% and a CPU headline of 97%. This is burst balance, not storage
quota being reset. Infrastructure reports the lowest sampled I/O balance over
seven days, so the headline alone is not a current instantaneous measurement.

The signed-in Database Observability page subsequently loaded and showed FREE
plan, memory commitment 2.35 GB labelled SEVERE, 1.28 GB space used and 2 GB
provisioned disk. Commitment is not the same as resident RAM; no claim of exact
swap consumption is made. The quota banner warns of restrictions from November
15, not proof that quota enforcement caused today's outage.

Separate minimal Auth health and REST requests each timed out at six seconds.
A session-metadata query with a three-second statement bound could not connect.
Project metadata saying ACTIVE_HEALTHY does not override those failed checks.
Resource pressure is a leading explanation; the exact active workload and the
contribution of the concurrent Supabase incident remain unverified.

Sources: [disk I/O explanation](https://supabase.com/kb/troubleshooting/exhaust-disk-io),
[Infrastructure metric semantics](https://supabase.com/docs/guides/platform/compute-and-disk).

## Repair and production proof

Runtime `71ee529b`, Vercel `dpl_CbFKK41ypVPv4mdGQY3uhTPkGzDr`, READY on both
canonical aliases. One three-second budget covers the complete middleware
authorization flow, aborts network fetches and refuses late cookie writes or
retry requests. Private pages/APIs fail closed with no-store 503 responses;
public login remains reachable. Transient Auth/grant read failures do not
deliberately sign users out. Owner confirmation and viewer allowlists remain.

- Full suite: 4,391 passed / eight skipped / zero failed.
- Focused availability/access suites: 36 passed; TypeScript and secret scan pass.
- Actual production GET with a synthetic invalid session-shaped cookie:
  `/dashboard` returned the safe 503 page in 3,358 ms, no 504, no private data,
  `Cache-Control: private, no-store`, `Retry-After: 30`.
- Same synthetic cookie on `/login`: HTTP 200 in 3,385 ms, no middleware 504.
  This proves timeout containment with the real SSR client, not a valid owner
  session or recovered database. No real session token was read or generated.

## Still required

Restore database responsiveness, then verify actual owner login and private
page reads. Bounded code repairs/index improvements do not instantly replenish
burst capacity. No workload culprit is invented while diagnostics cannot run.

Paid capacity is an owner decision: the published one-project Pro + Small
example is about $30/month before tax/other usage ($25 plan + ~$15 Small minus
$10 compute credit). Small has 2 GB RAM; this is a proposed recovery step, not a
guaranteed cure. Upgrading the plan alone does not resize an existing Nano
instance. Verify actual checkout and all active-project charges first. No paid
change has been made. [Billing example](https://supabase.com/docs/guides/platform/manage-your-usage/compute).

No restart, session termination, deletion, credential/access change, inference,
trade, or protective-control bypass was performed. If staying free, a separate
bounded workload-reduction plan must prioritize safety/operations over research
replays and document any lost collection cadence rather than hiding it.
