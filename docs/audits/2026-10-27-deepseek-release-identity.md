# DeepSeek release display and evidence identity

The owner approved showing the current advertised DeepSeek Flash release and
separating council evidence across provider updates. The official
[October 17 changelog](https://api-docs.deepseek.com/updates/) identifies
DeepSeek-V4.1-Flash-1017 behind `deepseek-flash`. The
[pricing documentation](https://api-docs.deepseek.com/quick_start/pricing/)
also maps that API alias to this advertised release. The longer weights name
is a display label, not a newly invented request ID.

## Implemented

- Shared model catalog supplies the release label, official source, verification
  date and explicit `provider_documented_alias` provenance. Settings uses this
  for per-flow active model labels and the council picker.
- New API/hybrid run configs freeze catalog provenance in existing JSON fields.
  Nothing is added to the model's research packet or prompts. No schema change.
- Existing versioned IC series additionally distinguish pre-October-17,
  October-17 rollout, post-update, unknown-time and newly documented-collection
  periods. Historical weights are unverified. Collection time is the proxy;
  research decision time can be older and is never used for this classification.
- Affected composite, paired deterministic and fixed-blend cells use the same
  release context. Actual API fallbacks are included when determining dependence.
  Independent subscription member series keep their own identity; debated
  subscription scores inherit a Flash context when applicable.
- Prediction Lab's read-only matched comparisons use the same identity helper.
  Learning displays readable context. Settings identifies legacy unpartitioned
  evidence and links to the complete returned Learning view when its compact
  table is truncated. Sessions/horizon is labelled a rough window count.

No provider key, API request model, selected roster, prompt, trading score,
position, risk limit, historical forecast or historical IC record is changed.
General coding benchmarks are not proof of financial predictive skill.

## Verification

Synthetic regression fixtures cover alias/display separation, documentation
snapshots, rollout boundaries, stale research timestamps, unknown timestamps,
matched baseline/composite/blend period counts, independent/debated subscription
identity, API fallbacks, and read-only Prediction Lab grouping. The evaluator
fixture has a complete five-symbol cross-section in each tested release period;
it never weakens the existing evidence floor to obtain a positive result.

Focused tests, TypeScript, full suite and secret scan are checked before release.
The focused suite passed 80 tests; the final full suite passed 4,505 with eight
skipped and zero failures (544 files passed). TypeScript and secret scanning
passed. The initial new fixture had fewer than five names per release and
correctly produced zero qualifying observations; it was corrected to use five
names per period rather than weakening the cross-section floor.
Exact mainline/production READY and read-only owner UI are verified at handoff.
One existing authenticated data-only evaluator invocation may publish a new
partitioned batch from stored forecasts; it is not an inference collector call.
No extra model quota or broker action is required.

## Limits

An API alias may change silently. The catalog is documentation verified on
October 27, not a live attestation of the exact weights used by every response.
Legacy period grouping is descriptive and explicitly unverified. Metadata
capture can reduce sample size; it does not create predictive skill or justify
model promotion. Raw historical observations remain available, and new immutable
evaluation batches do not rewrite older results.

## Production verification

Runtime commit `f8cd4f169437777c5a9c8a13c6d8dd5dff29f90d` matched remote main
and deployed READY as `dpl_22KbVnAyMzvUU9UCStkPwVNq3PCR`.
The owner Settings page returned 200, showing the advertised 1017 label on all
17 active DeepSeek flow rows while picker/request values remain `deepseek-flash`.
The provider-source/unverified-revision notice is visible. No document overflow
at 375/768/1440; no console errors were recorded.

One existing `kairos_call_agent` invocation targeted only the data-only council
evaluator. Its completed receipt published immutable batch
`439b90a7-2033-4461-9a0d-730ba49d02da` at 2026-10-27 11:49:37 UTC: 416 cells,
both markets and h2/h5/h10/h20; 320 cells have DeepSeek release-period tags.
The available historical data populate pre/post-update unverified periods;
there is no fabricated rollout-day or newly stamped forecast. All 416 cells
remain insufficient and all t-statistics are null. The configuration fingerprint
is identical before and after verification. No collector/inference was invoked.

The read-only US h2 Prediction Lab returned 200 with 134 method cells, including
64 release-labelled methods, and `shadowOnly=true`. New config provenance will
be observed on the next naturally collected API/hybrid forecasts; no extra job
was queued to manufacture that proof. Previous forecasts/evaluation batches,
selected models, prompts, budgets and trading controls are preserved.
