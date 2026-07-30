# Earnings Repricing Barrier

Status: Approved corrective safety change, implemented 2026-07-30.

## Problem

Daily technical inputs can remain pinned to the pre-earnings close after an AMC
or BMO release. On 2026-07-30, MSFT was a held position and received a
deterministic `short` from a July 29 close despite a July 29 after-close result.
That is a stale-data decision, not an informed reaction.

## Rule

When the existing PIT earnings calendar has a first-reported actual from the last
seven days, a research score cannot direct an entry or a score/direction exit until
the daily candle series has a date strictly after the report date.

- New candidate: direction becomes `neutral` and is ineligible for PaperTrader.
  The signal remains session-validated so consumers see this current
  abstention rather than falling back to an older pre-event direction.
- Held position: direction becomes `neutral`, preventing stale score/direction
  exits. Price stops, targets, trailing stops, and time exits are unchanged.
- The calendar lookup is read-only and provider-free. It never infers that an
  earnings beat means buy, and it never uses options as directional alpha.

## Scope

No migration, new provider, options call, score-weight change, manual-live change,
or paper/live order is added. The existing next research session after a complete
post-event daily bar resumes normal deterministic scoring.
