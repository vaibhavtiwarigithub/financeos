# Vibe External Research Runner - Implementation And Delivery Plan

> Status: PLAN FOR CLAUDE + OWNER REVIEW. NO RUNTIME IS ENABLED.
> Date: 2026-07-17
> Upstream: [HKUDS/Vibe-Trading](https://github.com/HKUDS/Vibe-Trading)
> Purpose: run selected deterministic Vibe Python research capabilities as a
> parallel comparison surface without using Kairos API keys or influencing Kairos
> decisions.

## 1. The Decision In Plain Language

Kairos will not connect the complete Vibe-Trading agent, MCP server, broker stack,
web search, memory, shell tools, or self-modifying skills.

The first integration will run only selected deterministic Python capabilities:

- factor/alpha benchmarking on a declared common universe;
- daily-bar strategy backtests for US and India;
- benchmark, drawdown, turnover, correlation, and attribution diagnostics;
- walk-forward, bootstrap, and Monte Carlo validation where the pinned release
  supports them safely;
- reproducible run cards and reports; and
- optional Pine v6 export from an already validated, owner-selected specification.

It will appear in Kairos as **External Research - Parallel Only**. Its output cannot
change a Kairos score, recommendation, rank, signal, strategy version, paper trade,
live proposal, position, cash balance, or order.

## 2. Locked Credential And Quota Rule

The Vibe runner receives **none** of the following:

- Finnhub, Massive, Alpha Vantage, EODHD, Twelve Data, Webull, Kite, Robinhood,
  Supabase, Vercel, Anthropic, DeepSeek, OpenAI, GitHub, or other Kairos keys/tokens;
- Kairos `CRON_SECRET`, service-role key, OAuth cookies, browser sessions, broker
  account data, callback credentials, or production environment variables; or
- access to a running Kairos process, production database, broker adapter, provider
  adapter, or internal network.

No Kairos provider budget is charged by the Vibe run. A run may use only:

1. immutable market-data files exported from facts Kairos has already persisted;
   reading these files makes no provider call; or
2. a separately isolated, no-secret public-data acquisition step using a reviewed,
   hash-pinned Python loader such as `yfinance` after live US and India `.NS` probes.

A Python library is not itself a data source: `yfinance` and similar libraries make
public network requests. They use no API key, but their upstream service can still
rate-limit, change schema, or change terms. Every such request is therefore labeled
`public_no_key`, isolated from Kairos quotas, fail-soft, cached only inside the run,
and never treated as execution-grade pricing.

## 3. Two-Container Boundary

### 3.1 Public acquisition container

This optional container may access only approved no-key public data. It receives:

- market (`us` or `india`), public symbols, date range, interval, and adjustment
  basis;
- no portfolio quantities, account identity, watchlist rationale, internal prompts,
  decision history, secrets, or callback token; and
- strict CPU, memory, wall-clock, output-size, process, and file limits.

It writes only normalized OHLCV/benchmark files plus source timestamps and warnings.
The trusted wrapper validates symbols, dates, finite values, currency, duplicate
bars, split adjustment, freshness, and maximum file size before those files can
reach analysis. Failure is an abstention.

Initial allowlist: `yfinance` only. Vibe's Tushare, AKShare, mootdx, OKX, CCXT, Futu,
web-search, MCP, and broker loaders remain disabled. India `.NS` behavior must pass a
live probe before India public-data runs are scheduled.

### 3.2 Offline analysis container

The selected Vibe Python code runs with:

- `--network none`;
- read-only root filesystem and read-only normalized input mount;
- one bounded writable output directory;
- non-root user, dropped Linux capabilities, no Docker socket/devices/host paths;
- no environment secrets, GitHub token, OIDC, package download, subprocess shell,
  dynamic plugin, MCP, browser, or callback access; and
- one code-known command selected from an approved manifest.

The container cannot upload its own results. A trusted Kairos-owned wrapper regains
control after exit, scans and schema-validates the output, and only then appends a
normalized artifact to Kairos.

## 4. Why The Full Vibe Agent Is Not Phase 1

The current upstream product contains a broad agent harness, many finance skills,
multi-agent swarm presets, web/file/shell/MCP tools, persistent memory, multiple LLM
providers, data loaders, backtests, and broker-oriented capabilities. That breadth is
useful in a standalone research workstation but is excessive authority inside an app
connected to real accounts.

Its full natural-language and swarm workflows require an LLM provider or a local
model. Kairos API keys and OAuth tokens will not be supplied. Downloading and running
a local Ollama model in GitHub Actions is not assumed free, fast, or reliable and is
not part of this plan.

Phase 1 therefore captures the most useful no-key deterministic capability without
adding an LLM or an autonomous external agent. A later local-model advisory committee
requires a separate review and remains parallel-only.

## 5. Source Ownership And Updates

1. Fork or mirror the exact permitted Vibe source release under the approved
   Vaibhav-owned GitHub organization, preserving its MIT license and notices.
2. Pin the source commit SHA, Python version, package hashes, container base digest,
   workflow Action SHAs, and produced image digest.
3. Build from reviewed source and lockfiles; never `pip install -U`, use `main`, use
   a floating image tag, or download dependencies during an analysis run.
4. Generate an SBOM and run dependency, secret, malware-pattern, license, and source
   scans before admission.
5. Disable all unselected modules at packaging time, not only through prompts.
6. Check upstream weekly for metadata only. Never auto-merge or auto-deploy. Every
   upstream commit becomes a new candidate release and repeats review, tests, and a
   parallel comparison before replacement.
7. If upstream disappears, the approved mirrored commit, lockfiles, image digest,
   license evidence, and tests remain reproducible.

## 6. Initial Capability Allowlist

| Capability | Phase 1 | Input | Output |
|---|---|---|---|
| Daily-bar backtest | Yes | One market, normalized OHLCV, benchmark, costs, strategy spec | Metrics and equity curve |
| Walk-forward/bootstrap/Monte Carlo validation | Yes | Completed bounded backtest | Validation diagnostics |
| Alpha/factor benchmark | Yes, bounded catalog | One market/common universe/PIT panel | IC, stability, coverage, turnover |
| Correlation/attribution | Yes | Returns and position-independent weights | Diagnostic artifact |
| Run card/report | Yes | Validated outputs | Escaped structured report |
| Pine v6 export | Owner-triggered only | Approved strategy spec | Read-only code artifact |
| LLM research agent/swarm | No | - | - |
| Web search/document ingestion | No | - | - |
| Persistent memory/self-evolving skills | No | - | - |
| MCP, shell, arbitrary files, brokers | Never | - | - |
| Cross-market shared-capital backtest | Never | - | - |

The alpha catalog is treated as a multiple-testing family. No factor enters Kairos
because it ranks well in one run. Results must report every attempted factor, not
only winners, and use Kairos DSR/PBO and walk-forward governance before any separate
native feature proposal.

## 7. Data Modes

### Mode A - Same-data comparison (default)

Kairos exports a minimum immutable public-market snapshot already present in its
database. The runner makes no network or provider calls. This answers: **does Vibe's
method produce different or better diagnostics on exactly the same facts?**

Export excludes account/portfolio state, owner identity, cash, orders, broker data,
internal prompts, private notes, and provider credentials. It contains one market,
native currency, symbols, OHLCV/returns, benchmark, as-of time, adjustment basis,
and hashes.

### Mode B - Independent no-key data check (optional)

The acquisition container retrieves the same declared symbols and dates from an
approved no-key public loader. This answers: **are differences caused by methodology
or by data?**

The UI must not blend Mode A and Mode B. It displays source, retrieved time,
coverage, missing bars, adjustment basis, and data disagreements. Mode B cannot
supply current execution prices or repair a missing Kairos scoring field.

**Point-in-time restriction:** history downloaded today from `yfinance` or another
public loader is retrospective. Prices may be restated for splits/corporate actions,
constituent availability may contain survivorship bias, and the downloaded dataset
does not prove what was available on each historical date. Merely validating an
`adjusted` flag does not repair this.

Therefore Mode B historical data is labeled `retrospective_public_history` and may
be used only for loader coverage, calculation smoke tests, and data-disagreement
diagnostics. It is excluded from alpha claims, DSR/PBO evidence, strategy comparison,
promotion, and any statement that a backtest was point-in-time safe. Acquisition
requests raw bars (`auto_adjust=false`) plus separately timestamped corporate actions
where supported, but this improves transparency rather than conferring PIT status.

If independent public data is ever needed for valid historical evaluation, Kairos
must freeze raw bars, actions, membership, and retrieval timestamps prospectively.
Only observations frozen before the evaluated decision time may later be marked
PIT-safe. Mode A remains the initial method-comparison dataset because it can reuse
Kairos's existing immutable/as-of lineage.

## 8. Kairos Product Surface

Add **Research -> External Lab** with four views:

1. **Runs:** status, market, mode, capability, source commit, data timestamp,
   duration, resource use, and validation state.
2. **Compare:** Kairos versus Vibe on the same universe/horizon/benchmark/cost model;
   show coverage and abstentions before performance.
3. **Evidence:** validation diagnostics, factor-trial family size, warnings,
   provenance hashes, and reproducibility information.
4. **Updates:** current pinned release, available upstream release, security/license
   review state, and explicit owner-controlled upgrade/rollback.

Every page carries a persistent `Parallel only - does not affect Kairos decisions`
status. There is no Promote, Apply, Trade, Replace score, or Enable live button.

## 9. Records And APIs

Extend existing `experiment_runs` and evidence lineage rather than create another
truth layer. Add only the minimum records needed for isolated compute:

- `external_research_releases`: approved source/dependency/image identities;
- `external_research_policies`: per-market state, daily job/minute/storage limits;
- `external_research_runs`: append-only run identity and resource/security status;
- `external_research_artifacts`: append-only validated result reference/hash; and
- `external_research_security_events`: normalized failures without raw hostile text.

Owner UI reads through RLS. The worker never receives a database credential. The
trusted wrapper uses a one-run, one-purpose callback proof after untrusted containers
have exited. Ingestion verifies issued run ID, snapshot hash, release/image digest,
market/currency, schema, payload size, finite numbers, allowed artifact type, and
expiry before append.

## 10. Build Phases And Effort

### Build-start readiness gate

The design is approved for review, but product sequencing should not consume a full
implementation sprint while the Kairos baseline still has known or unresolved
measurement questions. Before starting P0-P3 as a committed product build, require:

- the post-fix US and India signal re-score/certification audit is complete, with no
  open P0/P1 scoring-contamination finding;
- technical-score saturation is measured and its intended semantics are documented;
- at least one Learner cycle has completed successfully in each market using at
  least 10 **learning-eligible** closed trades per market; and
- the latest strategy evaluation can be reproduced from its dataset and strategy
  fingerprints without a schema, market, currency, or lineage failure.

The 10-trade gate proves the loop functions; it does **not** prove calibration or
strategy skill. Any comparative performance or superiority conclusion additionally
requires at least 30 eligible outcomes per market, confidence intervals, and the
existing multiple-testing controls. Below that floor, the External Lab may compare
deterministic calculations and expose disagreements but must display `insufficient
outcomes for performance conclusion`.

Production snapshot on 2026-07-17: India has 10 closed learning-eligible paper
trades; US has one closed paper trade and zero learning-eligible after exclusions.
This snapshot is informational and must be re-queried at build authorization.

P0/P1 could technically run on synthetic fixtures before these gates because they
have no production or decision impact. The recommended product sequence is still to
defer that work unless engineering capacity is otherwise idle: source audit and
sandbox plumbing do not answer whether Vibe adds value to Kairos.

### P0 - Source audit and pin (1-2 engineering days)

- Select exact Vibe commit and initial deterministic modules.
- Review license, dependency graph, network, subprocess, dynamic-import, file, MCP,
  broker, telemetry, serialization, and unsafe-evaluation paths.
- Create the Vaibhav-owned mirror/fork, lock dependencies, build SBOM, and pin image.
- Produce a deny-list proving excluded modules are absent/unreachable.

Exit: reviewed release manifest; nothing has run against Kairos data.

### P1 - Synthetic sandbox (1-2 engineering days)

- Build trusted GitHub Actions wrapper and two-container boundary.
- Use synthetic US and India fixtures only.
- Prove no secrets in the untrusted environments and prove analysis egress denial.
- Test timeout, memory/CPU/process/file ceilings and kill switches.
- Reject symlinks, path traversal, archives, huge/deep JSON, NaN/Infinity, ANSI/log
  injection, HTML/script/Markdown, unknown symbols, wrong market/currency, and extra
  files.

Exit: hostile fixture suite passes; still no production snapshot.

### P2 - Deterministic Vibe adapter (2-3 engineering days)

- Map normalized files into one selected Vibe backtest and validation path.
- Add same-data Mode A first; then live-probe no-key `yfinance` for US and India and
  add Mode B only if semantics and reliability pass.
- Enforce market-local benchmark/currency/cost/adjustment rules.
- Add bounded factor-bench support with complete trial-family reporting.
- Emit one versioned JSON result contract; no prose controls behavior.

Exit: reproducible local/synthetic runs for US and India.

### P3 - Kairos gateway, storage, and External Lab UI (2-3 engineering days)

- Add reviewed migrations, owner RLS, append-only triggers, narrow ingestion RPC,
  run issuance, result validation, retention, and global/per-integration kill switch.
- Add owner-triggered runs first; do not schedule automatically.
- Build Runs, Compare, Evidence, and Updates views.
- Show exact data mode and prove zero imports/writes into scoring or money-path tables.

Exit: end-to-end owner-triggered parallel run visible in Kairos.

### P4 - Repeated parallel observation (10-20 market sessions)

- Run bounded common-universe comparisons for each market.
- Measure coverage, data disagreement, runtime reliability, incremental diagnostics,
  false discoveries, cost/minutes, and whether outputs change owner understanding.
- Schedule at most one run per market/day only after five successful manual runs.
- Stop automatically at free-minute/storage limits; no paid overage.
- Separate three conclusions in every comparison: calculation disagreement, data
  disagreement, and measured incremental value. Do not use Kairos as an unquestioned
  yardstick or Vibe as an unquestioned challenger; synthetic known-answer fixtures,
  invariant tests, and PIT-safe observations arbitrate correctness.

Exit: evidence-based keep, narrow, or remove decision.

### P5 - Native adoption, only if proven (separate architecture)

External results never directly gain influence. If a method adds stable value, write
a clean, minimal Kairos-owned feature specification and test it through the normal
measure-only -> shadow -> paper -> live-review lifecycle. The upstream Vibe runtime
remains a comparator and can be disabled without changing Kairos behavior.

## 11. Timeline

The following clock starts **after the build-start readiness gate passes and the
owner authorizes implementation**. The current US eligible-outcome gate has not
passed, so there is no honest calendar start date yet. Assuming one uncontested
implementation worktree, a permissive exact source release, healthy GitHub Actions
capacity, and no source-audit blocker:

| Milestone | Approximate time from build start |
|---|---:|
| Reviewed source pin and sandbox skeleton | Day 2-3 |
| Deterministic US + India synthetic runs | Day 4-6 |
| First end-to-end parallel result in Kairos | Day 7-10 |
| Safe daily parallel schedule | Day 10-14 after five clean manual runs |
| Initial value/reliability assessment | Day 20-30 |
| Stronger keep/remove evidence | 4-6 weeks |
| Any decision-influencing native feature | Separate build, normally 6-10+ weeks total |

Therefore, the **Vibe external runner can be working as a parallel-only view in
approximately 7-10 engineering days after authorization**. It can begin scheduled
evidence collection approximately **10-14 calendar days after authorization**. The
readiness wait is additional and depends primarily on US learning-eligible closures
and scoring certification. It should not influence decisions merely because it runs
successfully.

## 12. Acceptance Tests

- Untrusted containers receive zero secrets and cannot reach Kairos/Supabase/brokers.
- Analysis egress test fails closed under `--network none`.
- Public-data acquisition receives no secret and cannot see private Kairos inputs.
- Killing or deleting the integration leaves research, paper, live, exits, and UI
  health operational.
- US/USD and India/INR runs cannot share data, benchmark, capital, or output rows.
- Mode A makes zero external/provider calls; Mode B makes no Kairos-keyed calls.
- Retrospectively downloaded Mode B history can never be marked PIT-safe or support
  alpha, promotion, or comparative-performance evidence.
- Output cannot write `agent_signals`, strategy/policy state, proposals, trades,
  positions, cash, orders, provider cache, or broker tables.
- Re-running the same pinned release and snapshot reproduces results within declared
  deterministic tolerance.
- Dependency/source/image changes invalidate the approved release.
- Full typecheck, Vitest, Next production build, migration/RLS/grant verification,
  workflow security checks, container hostile tests, and browser verification pass.

## 13. Disable And Incident Response

The owner can disable all external research or one release immediately. Disable
prevents new jobs and callback acceptance but retains immutable run evidence. The
workflow can also be disabled at GitHub. Callback proof is revoked, pending outputs
are quarantined, and the release is marked retired.

Because no external output is a Kairos dependency, disabling Vibe requires no score,
position, order, provider, or database rollback. This is the core architectural test:
Kairos must work exactly as before when the entire external runner is absent.

## 14. Required Review Decisions

Recommended defaults for review:

1. Approve deterministic Vibe capabilities only; no LLM/swarm in the first release.
2. Approve Mode A immediately and Mode B only after no-key US/India live probes.
3. Approve one owner-triggered run at a time, then at most one run/market/day.
4. Approve zero paid GitHub Actions overage and 30-day detailed-artifact retention.
5. Treat the current blanket dependency on Canonical Evidence Router cutover as not
   applicable to this no-key, no-influence deterministic P0-P4 path. Router cutover
   remains required before any future Router-evidence or decision-influencing use.
