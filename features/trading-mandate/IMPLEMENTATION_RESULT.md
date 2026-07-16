# Trading Mandates Implementation Result

Status: Complete
Completed: 2026-07-12
Commit: `5616338` (`feat: add cross-market trading mandates`)
Production migration: `168_trading_mandates.sql` applied and verified on FinanceOS Supabase project `dionkikgdmlaotvtbnfr`.

## Delivered

- Independent US and India Trading Mandates.
- Separate horizon, strategy preference, horizon governance, and existing-position policy.
- Owner-only Settings API and market-aware Settings panel.
- ResearchAgent applies bounded evidence tilts and persists mandate provenance.
- PaperTrader writes entry-time mandate snapshots and resolved horizons.
- PositionMonitor honors snapshots and counts weekdays rather than calendar days.
- LearnerAgent receives the mandate as immutable context.
- US TraderAgent applies the US mandate threshold and records it in proposal risk context.
- Production database verified: mandate table, US/India seed rows, paper trade/position provenance columns, and owner-read RLS policy.

## Verification

- 311 tests passed; 6 skipped.
- TypeScript passed.
- Production build passed.
- Dependency audit found zero vulnerabilities.
- No broker orders, previews, live enablement, or deployment mutation was performed.

## Follow-Ups (Not Blocking Completion)

- Verify the normal Vercel Git integration deploys commit `5616338`.
- Add exchange-holiday calendars; current holding-age logic excludes weekends only.
- Show mandate provenance more broadly in portfolio and proposal detail views.
- Use mandate defaults in manual backtest controls.

These follow-ups do not block mandate configuration or the core US/India agent behavior.

## 2026-07-16 Safety Addendum

- Added owner-configurable `max_open_positions` per market (default 10). It is an entry-only gate: lowering it below the current book never liquidates positions.
- Added `max_signal_age_sessions` per market (default 2). PositionMonitor ignores stale score/direction evidence but continues stop, target, time-stop, hedge, and other price-based exits.
- The fill RPC reads the canonical mandate cap and treats the application parameter as tighten-only defense in depth.
- Research now unions current paper alpha positions with only the latest live snapshot per account. Held symbols are marked `isHeld`, researched before discovery, and do not consume the new-candidate cap.
- Migration `20260716013000_mandate_capacity_and_score_freshness.sql` was applied to `dionkikgdmlaotvtbnfr`. Production remained at 11 US / 13 India alpha positions, proving the cap change did not force-close.
- Correlation-aware P0/P1 was not activated because candidate-to-book pair observations are not persisted today. The corrected prerequisite and shadow gate are recorded in `features/correlation-aware-construction/FEATURE_ARCHITECTURE.md`.
