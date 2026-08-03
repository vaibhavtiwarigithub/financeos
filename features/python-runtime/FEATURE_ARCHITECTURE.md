# Python Runtime — Feature Architecture

Status: **Implemented (measure-only). Not wired into any decision path.**
Shipped 2026-08-03. Related: `docs/arch/02-tech-stack.md`, `lib/edges/ic.ts`.

---

## 1. Why

Kairos is TypeScript, but a large share of the statistics it needs already exists,
tested and peer-reviewed, in free Python libraries. Newey-West HAC standard
errors, Spearman correlation, the deflated Sharpe ratio and purged-fold machinery
are one `statsmodels` import away; in TypeScript they are hand-rolled.

`lib/edges/ic.ts` is the concrete case. It implements Spearman plus a
Bartlett-kernel Newey-West standard error by hand, and until now was only ever
checked against itself. A reference implementation is the difference between
"our IC t-stat is 2.1" and "our IC t-stat is 2.1 and we can prove the estimator
is right."

Standing constraint: **$0 cloud.** Both lanes below are free tiers already in use.

---

## 2. Two lanes, split by what each can survive

| | Lane A | Lane B |
|---|---|---|
| Where | Vercel Python Function | GitHub Actions |
| Trigger | HTTP POST from TypeScript | Weekly cron / manual dispatch |
| Time budget | 30s (`maxDuration`) | 30 min (`timeout-minutes`) |
| Dependency budget | 500MB bundle, cold-start sensitive | effectively unbounded |
| Use for | An answer needed *now*, modest deps | Backtests, ML, long rotations |

Choosing between them is a latency question, not a taste question. If the caller
is waiting, Lane A. If nothing is waiting, Lane B — it has no timeout pressure
and no bundle limit.

### Lane A — `api/py/ic.py`

`POST /api/py/ic`. Spearman rank IC per cross-section, then a Newey-West HAC
standard error over the IC series.

- **Auth:** `x-cron-secret` compared against `CRON_SECRET` with
  `hmac.compare_digest`, **failing closed when `CRON_SECRET` is unset** — the
  same contract as `verifyCronSecret` in `lib/auth/cron.ts`. Never anonymous.
- **Pure:** JSON in, numbers out. No database, no market data, no LLM.
- **Bounded:** `MAX_PERIODS` 2000, `MAX_OBS_PER_PERIOD` 5000, `MAX_BODY_BYTES`
  4MB, so one request cannot pin a serverless CPU.
- `newey_west_lag()` mirrors `neweyWestLag` in `lib/edges/evidence.ts` so the two
  runtimes pick the same lag from the same horizon/step.

Vercel entrypoint convention: the class must be named `handler` and subclass
`BaseHTTPRequestHandler`. Each `.py` under `api/` becomes its own function.

### Lane B — `scripts/python/lane_b_analysis.py` + `.github/workflows/lane-b-python.yml`

Weekly (`30 4 * * 0`) plus `workflow_dispatch`. Template for long-running work.

- `permissions: contents: read` — no write scope.
- `concurrency` group prevents overlapping runs.
- Self-check runs **before** the analysis; a broken build fails loudly first.
- **Dry-run by default.** With `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`
  absent it prints its payload and exits 0, so a missing secret cannot produce a
  half-write.

Secrets to add under *Settings → Secrets and variables → Actions* before it
writes anything: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (secrets), and
`LANE_B_TABLE` (a repository *variable*, not a secret).

---

## 3. Verification

Both self-checks run locally and pass.

Lane A cross-checks the TypeScript implementation, which is the whole point:

```
python  nw_se           = 0.015654709709910813
ts_reference_nw_se      = 0.015654709709910807
```

Agreement to ~1e-17 over 60 periods at lag 4. `lib/edges/ic.ts`'s hand-rolled
Bartlett-kernel Newey-West is correct.

Lane B self-check: OLS over 500 synthetic points, slope 0.0198, t 63.0, R² 0.889.

`npx tsc --noEmit` clean and `npm run build` clean **with Python present in the
tree** — the primary integration risk (Python breaking the Next.js build) is
cleared.

**Not verified:** actual Vercel deployment of the Python function. Cold start,
real bundle size, and the deployed auth path are unmeasured. The first deploy is
the test.

---

## 4. Bundle and cold start

Python Vercel Functions include **all files reachable at build time** — there is
no tree-shaking. `vercel.json` therefore scopes `api/py/*.py` with
`excludeFiles` covering `.next`, `node_modules`, `app`, `components`, `lib`,
`tests`, `docs`, `features`, `knowledge`, `public`, `supabase`, `scripts`,
`types` and `backups`. Without that the Next.js tree ships inside the Python
bundle against a 500MB limit.

`requirements.txt` is deliberately minimal — `statsmodels` transitively pulls
numpy, scipy and pandas, which is already most of the budget. Every addition
costs cold-start latency. Keep it short.

Python cold starts are slower than Node. Acceptable for crons and analysis;
**not** acceptable on a page render.

---

## 5. Boundaries

- **Measure-only.** Nothing here is wired into ResearchAgent, PaperTrader,
  PositionMonitor, the learner, the Router, or any broker path. No existing cron
  calls Lane A.
- No score, eligibility, sizing, entry, exit, promotion or broker behaviour is
  affected.
- Wiring any Python output into a money decision is a **separate proposal
  requiring owner approval**. Cross-checking an estimator is not the same as
  letting it decide anything.
- Two dependency systems now coexist (`package.json` and `requirements.txt`).
  That is the ongoing cost of this approach and is accepted deliberately.

---

## 6. Out of scope

Not built, and not to be added without a reason: a shared Python client library,
a generic RPC layer, per-request package installs, ML model serving, or any
Python on a user-facing render path.
