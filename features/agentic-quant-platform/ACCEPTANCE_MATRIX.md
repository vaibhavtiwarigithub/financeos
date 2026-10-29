# Adaptive Quant Platform — 16-case Acceptance Matrix

This matrix is the acceptance contract for the governed adaptive quant platform. It
reuses the existing implementation and test suites; it does not grant trading,
promotion, or live-enablement authority. CI runs the application tests and a fresh,
disposable Supabase replay. No production database or broker is contacted.

| ID | Acceptance invariant | Existing regression coverage | Verification lane |
|---|---|---|---|
| J01 | Point-in-time packets include only records knowable at the frozen decision date and produce a stable manifest. | `tests/replay-packet.test.ts` | Vitest |
| J02 | A future-stamped record reaching a sealed replay accessor throws instead of being silently filtered. | `tests/sealed-accessor.test.ts`, `tests/replay-packet.test.ts` | Vitest |
| J03 | Training/replay sees only labels matured by the evaluation date and uses the declared horizon. | `tests/label-window.test.ts`, `tests/replay-packet.test.ts` | Vitest |
| J04 | Calibration and experiment comparisons use purged, point-in-time folds and do not select a result from an incomplete declared family. | `tests/calibration-oos.test.ts`, `tests/replay-eligibility.test.ts` | Vitest |
| J05 | US and India reads, outcomes, and eligibility remain market-scoped. | `tests/market-scoped-reads.test.ts`, `tests/replay-eligibility.test.ts` | Vitest |
| J06 | Research, portfolio construction, and execution share an immutable, market-scoped decision reference without changing the score. | `tests/decision-contract.test.ts` | Vitest |
| J07 | Council forecasts remain isolated from deterministic score and execution decisions. | `tests/llm-council-isolation.test.ts` | Vitest |
| J08 | LLM directional text cannot override deterministic held-position exit direction. | `tests/signal-direction.test.ts` | Vitest |
| J09 | A challenger cannot become a market champion without linked passed validation; force bypass is rejected. | `tests/strategy-promotion-route.test.ts` | Vitest |
| J10 | Missing, stale, mismatched, invalid, or non-positive autonomous calibration fails closed at zero size. | `tests/autonomous-sizing.test.ts` | Vitest |
| J11 | Manual and autonomous execution delegate through the shared execution-kernel contract; autonomous-only controls cannot use owner overrides. | `tests/autonomous-kernel.test.ts`, `tests/execute-order-ack.test.ts`, `tests/kill-and-exit.test.ts` | Vitest |
| J12 | A broker acknowledgement is persisted and remains reconcilable; an ambiguous acknowledgement is not reported as a confirmed fill. | `tests/execute-order-ack.test.ts`, `tests/kill-and-exit.test.ts` | Vitest |
| J13 | A tripped kill switch blocks new buys, cancels only eligible resting buys, preserves protective sells, and reconciles cancel/fill races. | `tests/kill-and-exit.test.ts`, `tests/protective-cancel-confirmation.test.ts` | Vitest |
| J14 | Database RPC permissions distinguish anon from service role on a fresh schema. | `tests/db-integration.test.ts` — schema and permission probes | Disposable local DB |
| J15 | The reservation RPC's atomic budget behavior is exercised only in the disposable local database using synthetic test rows; it never submits a broker order. | `tests/db-integration.test.ts` — atomic reservation | Disposable local DB |
| J16 | The complete ordered migration chain can recreate a clean Supabase database from repository files. | Supabase CLI `start` in `.github/workflows/adaptive-quant-acceptance.yml` | Disposable local DB |

## Status

- The code-level matrix is mapped to existing focused regression suites.
- The clean replay lane is configured for matching PRs and `main` changes. It
  passed with the full application contracts and TypeScript check in GitHub
  Actions run `40965947947` on commit
  `20e531a4e564224cf87e9209749d9216fd387c4f`; that run replayed the complete
  migration chain and passed the disposable local RPC permission/reservation
  checks.
- The local desktop cannot run the Supabase stack because Docker is unavailable;
  this does not weaken the CI gate. No linked/production reset or migration command
  is used by this workflow.
- Passing this matrix proves contracts and migration reproducibility only. It does
  not prove predictive alpha, market outperformance, readiness to promote, or live
  execution readiness. Those remain subject to their separate matched, matured,
  out-of-sample evidence gates.
