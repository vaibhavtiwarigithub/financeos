# Architecture-to-Production Conformance Baseline

> Date: 2026-08-06
> Scope: shared architecture chapters, the active five-day implementation range
> (`20c97b37..0a2f3757`), current production configuration, migrations, cron
> execution, and money-path reachability. This is an evidence baseline, not a
> claim that Kairos has demonstrated alpha.

## Executive truth

Kairos is an autonomous **paper** research-and-trading system with separate US/USD
and India/INR pools. It is not an autonomous live-trading system today.

Production state verified on 2026-08-06:

| Control | US | India | Meaning |
|---|---:|---:|---|
| Live mode | `manual` | `manual` | Owner approval remains required for live orders. |
| `live_auto_enabled` | `false` | `false` | Autonomous live workflow exits before provider work or a proposal write. |
| Protective order placement | `false` | `false` | Autonomous live entry interlock remains closed. |
| `webull_trade_orders_enabled` | `false` | N/A | Signed Webull execution is unreachable. |
| Router active policy | `false` | `false` | Evidence Router remains a parity/shadow system. |
| Promotion endpoint | disabled | disabled | No strategy policy can be promoted from current IC diagnostics. |

`trading_enabled` and per-market controls are true, which permits the existing
paper loop and owner-confirmed live workflows. That does not arm automatic live
execution.

## Verified operating contracts

1. **Market isolation:** all current paper and live policy queries scope market
   state; USD and INR values are not pooled.
2. **Money-path determinism:** the reviewed paper, PositionMonitor, broker, and
   autonomous-live paths do not invoke an LLM as a decision authority.
3. **Paper autonomy:** ResearchAgent produces market-local signals; PaperTrader
   can fill qualifying paper BUYs; PositionMonitor retains independent mechanical
   exits. Kill switches and market pauses block entries without blinding research.
4. **Learning discipline:** outcome/label, backtest, feature, edge, event, and
   exit programs are measurement systems unless their own gate says otherwise.
   Current promotion remains fail-closed.
5. **Router discipline:** active policies are router-disabled; evidence collection
   has no score or execution authority.
6. **Production health sampled:** no failed pg_cron run was found in the prior
   three days. This is operational evidence, not a guarantee against future failure.

## Corrections made during this audit

- Corrected the exit-path shadow so it uses the actual market mandate proxy,
  decision-time price, and complete 20-session paths. It remains measurement-only.
- Bound the `get_daily_ai_count` security-definer RPC to its authenticated caller
  and revoked anonymous execution.
- Excluded idiosyncratic event outcomes without an aligned benchmark from
  benchmark-neutral cohorts; the report now exposes the exclusion count.
- Repaired historical paper-trade compatibility P&L projections from canonical
  `pnl_pct`, preserving four-decimal precision. No cash, position, or outcome was
  changed.

## Documentation status

The shared chapters are the operational authority. Feature architecture files are
not automatically implementation records: there are many design documents and only
a small subset has `IMPLEMENTATION_RESULT.md`. A feature without a result and a
matching shared-chapter/code contract must be treated as **proposed or unverified**,
not shipped.

The system map contains both active and future/dormant workflows. Its node detail
for AutonomousLive correctly records the current deployment flag as false, but its
topology should not be read as evidence that orders are currently placed. The
production controls above are authoritative.

## Remaining audit work

This baseline completes the highest-risk conformance pass; it does not certify every
historical feature proposal. The next audit slices are:

1. Map every feature document to `proposed`, `shadow`, `implemented`, `retired`, or
   `superseded`, with the owning code, migration, schedule, and shared chapters.
2. Reconcile the system-map labels with current dormant states so the overview cannot
   imply active autonomous live execution or active promotion.
3. Add a CI check requiring an implementation result and appropriate chapter updates
   for newly shipped feature directories.
4. Keep promotion disabled until sealed point-in-time, market-local, cost-aware,
   out-of-sample evidence satisfies the documented gate.

## Non-claim

No part of this audit establishes that Kairos will beat VOO, NIFTY, or any other
benchmark. The defensible product objective is controlled learning: improve only
when predeclared evidence and forward observations support a change, and otherwise
make no strategy change.
