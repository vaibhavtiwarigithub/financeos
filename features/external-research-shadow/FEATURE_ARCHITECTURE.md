# External Research Shadow Runtime

> Status: **REVIEWED DESIGN DRAFT. NOT APPROVED FOR IMPLEMENTATION.**
> Last reviewed: 2026-07-15 by Codex.
> Authority: subordinate to `features/external-research-integrations/FEATURE_ARCHITECTURE.md`.
> Scope: optional, record-only research compute. No money-path authority.

## 1. Decision

Do not run a “self-sourcing” external repository as the first phase. Self-sourcing
requires outbound network and usually credentials, which contradicts the required
`docker run --network none` compute boundary. Independent data can be valuable, but
acquisition must occur in a reviewed Kairos-owned adapter before untrusted compute.

The only approved conceptual runtime is:

1. trusted Kairos acquisition freezes a minimal public-market-data snapshot;
2. untrusted, pinned compute receives that snapshot with no network or secrets;
3. a trusted wrapper validates and ingests a bounded artifact; and
4. Kairos evaluates it as research evidence only.

No external repository directly becomes a Kairos agent, candidate-discovery source,
Challenger, scorer, provider adapter, or broker dependency. A useful result may
motivate a separately specified, clean-room, Kairos-owned deterministic feature.

## 2. Preconditions

Do not build this runtime until all are true:

- Router cutover and eligibility guard are complete for the target market;
- experiment lineage can reference Router policy/evidence fingerprints without a
  third provenance system;
- an exact repository commit, license, transitive dependency lock, and capability
  have passed source/security/legal review;
- the same hypothesis cannot be tested more cheaply and safely in native Kairos;
- an owner-approved resource budget, kill switch, retention policy, and threat model
  exist; and
- a synthetic fixture run passes before any real snapshot is exported.

This makes the feature optional and later than native experiment lineage.

## 3. Trust Boundaries

### Trusted control plane

A Kairos-owned workflow repository and reviewed wrapper may:

- construct a job manifest from an approved integration registry entry;
- download a prebuilt, digest-pinned compute image or build from a reviewed lock;
- place the immutable input snapshot in a bounded read-only mount;
- launch `docker run --network none` with hard resource restrictions;
- validate/scan the output after the container exits; and
- upload only the accepted artifact and trusted wrapper logs.

### Untrusted compute plane

The repository code receives:

- no GitHub token, OIDC token, environment secret, provider key, broker token,
  Supabase credential, browser cookie, portfolio/account data, or callback proof;
- no outbound or inbound network;
- no host Docker socket, privileged mode, device access, or writable host path;
- a read-only input mount and one size-bounded output directory;
- a read-only root filesystem where compatible, non-root UID, dropped capabilities,
  PID/memory/CPU/time limits, and a process/file-size limit; and
- one approved command with no user-supplied shell fragment.

The repository cannot upload artifacts itself. The trusted wrapper regains control
after exit, rejects unsafe files/links/archives, validates JSON, and uploads only the
normalized result.

GitHub-hosted runner ephemerality is defense in depth, not the sandbox. Job-level
Actions `container:` is not treated as proof of network isolation; the reviewed
wrapper must execute the explicit no-network container and test egress denial.

## 4. GitHub Actions Security Baseline

- workflow exists only in a Kairos-owned private control repository;
- no `pull_request`, `pull_request_target`, issue-comment, or fork-controlled trigger;
- manual/scheduled dispatch selects only code-known integration IDs;
- top-level `permissions: { contents: read }` or stricter; no write permission;
- no cloud OIDC, deployment environments, production secrets, or persistent runner;
- every third-party Action is pinned to a full commit SHA and reviewed;
- no untrusted cache restore, reusable workflow from a floating ref, or mutable tag;
- concurrency is one, timeout and daily job caps are enforced before dispatch;
- no paid overage; quota exhaustion is an abstention;
- source/image/dependency digests, action SHAs, runner image, and wrapper version are
  written to the run record; and
- hostile-output fixtures test ANSI/log injection, symlinks, path traversal, zip
  bombs, huge JSON, NaN/Infinity, deep nesting, HTML/Markdown/script, and bad market.

## 5. Immutable Snapshot Contract

Do not export mutable `evidence_cache_v2` rows directly. Create an immutable research
snapshot manifest that references existing evidence and lineage records:

```ts
type ExternalResearchSnapshot = {
  snapshotId: string;
  snapshotHash: string;
  schemaVersion: string;
  market: "us" | "india";
  currency: "USD" | "INR";
  asOf: string;
  policyVersionId: string;
  experimentRunId: string;
  universeVersion: string;
  symbols: string[];
  evidenceRefs: Array<{
    evidenceRecordId: string;
    envelopeHash: string;
    intent: string;
    availableAt: string;
  }>;
  files: Array<{ path: string; sha256: string; bytes: number }>;
};
```

The materialized files contain only the minimum normalized public-market facts
needed by the capability. Exclude owner identity, watchlist rationale, account,
holdings, orders, fills, cash, broker, credentials, internal prompts, and raw
provider responses. A historical snapshot enforces `availableAt <= asOf`.

Provider acquisition remains in Router-owned adapters with normal quota, license,
and terms controls. An external project's data loader, URL, key, browser automation,
or MCP tool is never admitted into the untrusted container.

## 6. Output Contract

```ts
type ExternalResearchArtifact = {
  schemaVersion: string;
  runId: string;
  snapshotHash: string;
  integrationId: string;
  sourceCommit: string;
  imageDigest: string;
  market: "us" | "india";
  asOf: string;
  status: "completed" | "abstained";
  artifactKind: "hypothesis" | "critique" | "numeric_signal" | "backtest_report";
  coverage: { eligibleN: number; resolvedN: number };
  payload: unknown;
};
```

The trusted gateway checks exact IDs/hashes, market/currency, schema/version,
bounded strings/arrays/numbers, finite numeric values, symbol allowlist, payload
size, and allowed artifact kind. Rationale is stored/rendered as escaped plain text;
URLs, executable code, raw HTML/Markdown, files, and tool instructions are rejected.
Invalid output records a run failure but does not persist a partial advisory.

## 7. Records Without A Parallel Truth Layer

Extend the approved experiment-lineage model with:

- `external_research_runs`: experiment ID, integration release, snapshot fingerprint,
  wrapper/action/image digests, resource use, status, and failure code;
- `external_research_artifacts`: run ID, kind, schema, payload hash, storage reference,
  validation status, and retention class; and
- security events containing normalized codes only.

These records reference existing `experiment_runs`, Router policy/evidence records,
and labels. They do not copy source provenance into a third ledger. Do not create an
`external_advice` table that pretends a repo generated a Kairos decision, and do not
manufacture `decision_observations` to improve sample size.

RLS is owner-read; only a service-role RPC owned by the trusted gateway may append a
result for the exact issued run. Tables are append-only and reject update/delete.

## 8. Evaluation

External output is compared only on a predeclared common universe, as-of time,
horizon, benchmark, and cost model. Numeric signals must be alignable to existing
observations without selecting only names the repo liked. Report missingness and
abstentions.

Every repository, commit, prompt/configuration, signal definition, regime slice,
and horizon is part of the trial family. Use walk-forward/holdout evaluation and
DSR/PBO governance. “Who beats us where” is not a product claim unless confidence,
coverage, multiple testing, and incremental value over the champion are shown.

An external artifact can remain advisory indefinitely. Promotion means writing and
validating a native Kairos feature under a new architecture; it never means wiring
the upstream runtime into candidate discovery or trading.

## 9. Licensing And Supply Chain

Runtime execution does not make license obligations disappear. Before admission:

- verify the exact commit's license and every bundled/transitive dependency;
- define whether the use is copy, modification, distribution, or network service;
- obtain explicit legal/product approval for copyleft, source-available, unclear,
  missing, or changed licenses;
- generate/store SBOM and vulnerability/malware scan results;
- mirror source/artifacts only when the license permits it; and
- never auto-sync upstream. A new commit is a new release and repeats review/tests.

Clean-room reimplementation applies to ideas later rebuilt in Kairos. It is not a
substitute for complying with the license of code actually executed.

## 10. Phases

1. **P0 synthetic harness:** Kairos-owned toy program, synthetic data, egress-denial
   and hostile-output tests. No third-party repo and no production snapshot.
2. **P1 one reviewed capability:** one permissively licensed, exact-pinned repo on a
   minimal immutable snapshot, record-only, owner-triggered, no LLM required.
3. **P2 repeated shadow:** scheduled bounded runs after retention/cost review; common-
   universe evaluation, still no influence.
4. **P3 native hypothesis:** if evidence warrants, design a separate clean-room
   Kairos feature and send it through normal measure/shadow/validation governance.

Vibe is not automatically P1. Its breadth and agent/tool surface increase review
cost; a minimal adapter must be justified and source-audited first.

## 11. Disable, Incident Response, Acceptance

A code-owned global kill switch and per-integration policy stop dispatch immediately.
Revoke wrapper credentials, disable workflow, quarantine unvalidated artifacts, and
retain immutable audit metadata. Existing Kairos research/scoring/trading continues
unchanged because there is no runtime dependency.

Acceptance requires a proven egress-denial test, zero secrets exposed to compute,
hostile artifact rejection, reproducibility from hashes, per-market isolation,
quota stop, append-only/RLS tests, and explicit proof that no import/call path reaches
signals, strategy activation, broker adapters, or order execution.

## 12. Owner Decisions Before Build

1. Whether this optional framework is worth building after native lineage.
2. The first narrow capability, exact commit, and license class.
3. Maximum daily Actions minutes/storage and retention.
4. Whether private GitHub Actions is acceptable as the initial control plane after
   the sandbox threat model is independently reviewed.
