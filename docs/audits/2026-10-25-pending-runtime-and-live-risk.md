# Pending-work recovery: runtime and live risk

## Council runtime

The saved Codex and Claude supervisor PIDs were absent. Existing hidden supervisors
were restarted using the existing private config paths, without opening configs,
rotating credentials, creating schedules, or enqueueing inference. Production
heartbeats advanced to 2026-10-26 01:19 UTC for both workers; zero queued/leased jobs
were present. Existing Windows Startup entries point to the installed supervisors.
This recovers the current session, not unattended availability while the PC is off.

## Daily live-risk source repair

Webull live accounts already had an authoritative read-only MCP capture adapter,
but the daily holding-risk route omitted it. The route now reuses the existing
registry and driver, in the configured market, preserving independent account IDs.
It excludes simulated books and skips failed or unidentified captures. No formula,
model, roster, order permission, protective-stop setting, or historical record changes.

Regression fixtures cover connected Webull, duplicate symbols across accounts,
India isolation, unconnected providers, unknown identity and capture failure. They
stop at the existing run claim without provider inference or snapshot publication.
Verification: 63 focused tests passed; full suite 4,437 passed, eight skipped,
zero failures (533 files passed, one skipped). TypeScript, secret scans and diff
whitespace checks passed. No schema change was required.
The next natural daily risk run must establish production collection; an anonymous
authentication smoke check cannot prove that outcome.

## Unresolved evidence and boundaries

- The new India constituent warnings are production source timeouts. Official
  NIFTY 50/IT/Bank/Next 50 CSVs returned HTTP 200 locally, which is not evidence
  that the production collector has recovered. Alerts remain truthful.
- The US October 23 canonical EOD row remains missing; an agent receipt does not
  replace it. Do not manufacture a financial record or invoke trading to test it.
- Kite requires the owner's current login. CASHCAT-USD lacks a required daily
  candle; the collector must retain an incomplete state.
- Universal broker stop coverage and regime-adaptive loss/re-entry rules are not
  delivered by this repair. Protective-order lifecycle and account mandate gates
  remain required. The council remains shadow-only; immature IC is not a failure.
- Paired portfolio attribution producers and other ongoing research programs
  remain separate claimed work, not completed by restoring worker processes.

No paid service, compute upgrade, data deletion or new collection schedule was used.
