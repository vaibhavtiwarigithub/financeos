# Council runtime recovery — October 24, 2026

## Verified repairs

The council evaluator had no newer batch than October 22 despite Friday's scheduled slot. Both local subscription supervisors' saved process IDs were absent, although the owner's interactive Windows session and their existing configuration files were available. Configuration contents and credentials were not read.

Restarted the existing hidden supervisors using the installed bundle and saved configuration paths. Preserved their existing lane count. Production worker heartbeats advanced to October 25 at 01:14:23 UTC for both Codex and Claude. There were zero queued or leased jobs; no test forecasts or additional inference were requested. These local workers still require the computer and signed-in session to remain available.

Invoked the existing authenticated, data-only council evaluator once through the service dispatcher. It completed at **2026-10-25 01:14:16 UTC**, publishing batch `0a10f1e7-8bb0-4141-a309-dbd6309dcfc2` atomically:

| Market | Cohort | Cells | Horizons |
| --- | --- | ---: | --- |
| US | all_research_v1 | 22 | 2, 5, 10, 20 sessions |
| US | near_threshold_entry_long_v1 | 22 | 2, 5, 10, 20 sessions |
| US | forecast_available_close_v2 | 72 | 2, 5, 10, 20 sessions |
| India | all_research_v1 | 22 | 2, 5, 10, 20 sessions |
| India | near_threshold_entry_long_v1 | 22 | 2, 5, 10, 20 sessions |
| India | forecast_available_close_v2 | 72 | 2, 5, 10, 20 sessions |

All **232 cells remain insufficient evidence**, with null t-statistics. Maximum qualifying sessions were US 7/5/0/0 and India 9/6/0/0 for h2/h5/h10/h20 respectively. This is restored measurement, not demonstrated predictive skill or permission to promote a strategy. No historical scores or labels were rewritten.

The missing Friday invocation's root cause is not established. A successful catch-up does not prove the next scheduler run will succeed; inspect its natural receipt after the next weekday 23:30 UTC slot.

## Verification

`llm-council-evaluator-cron`, `llm-council-evaluator-batch`, and `council-worker-supervisor`: **3 test files, 11 tests passed**. These are mocked/local tests, not paid inference. No application code, schema, credentials, roster, prompts, risk settings or trading behavior changed during this recovery.

## Remaining prioritized queue — not claimed repaired

1. Missing canonical US October 23 paper EOD and partial research/prewarm coverage need producer-specific repair; do not fabricate marks or invoke trade-placing jobs for testing.
2. US accuracy brake remains active; insufficient or negative rotation evidence remains blocked. Latest inspected US correlation cohort was 5/6 pairs; India was 7/7 with a failing correlation verdict. Neither is a reason to bypass gates.
3. Dimension diagnostic snapshots last observed October 22 and some shadow producers need per-program expected-session checks. Do not launch unbounded historical scans merely to clear health warnings on Free compute.
4. Kite needs the owner's daily login; CASHCAT lacks usable daily candles. Council-unscored symbols must wait for authorized natural collection, not extra inference under this watchdog.
5. Database physical usage remains approximately 1.37 GB after the separately verified cache prune. No physical quota recovery, I/O-credit restoration or paid upgrade is claimed.

The leveraged request-clock defect was already repaired and verified in the October 22 audit. Latest inspected natural SOXL/SOXS/TQQQ/SQQQ doors completed October 23. Quote collection does not prove a broker protective-order lifecycle.
