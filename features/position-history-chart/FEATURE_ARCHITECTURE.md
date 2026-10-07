# Open Position History Chart — Feature Architecture

**Status:** Implemented locally; production build stalled before verification. Read-only UI; no migration or trading-policy change.
**Owner:** Vaibhav
**Why:** Make each held paper position's path since entry visible beside its current P&L, while preserving the distinction between share-price movement and portfolio cash-flow effects.

## Decision

Render a compact, market-local sparkline inside each open paper-position card. Use the append-only `paper_position_marks` ledger, keyed by the current position ID, as the historical mark source. The plotted value is percentage price movement from the first valid mark at/after entry—not historical position value or realized P&L.

The UI batches all currently held position IDs in one read request and loads lazily after the position list is visible. It displays the latest mark date and a clear no-data/stale state. No chart may trigger provider fetches, write marks, mutate a position, or place an order.

## Why this source and measure

- `paper_position_marks` records market, position ID, symbol, quantity, mark, source, observed time, provenance, stale status, and session date in an append-only ledger.
- Daily close marks are suitable for a compact path view but do not provide an intraday execution path.
- Quantity can change after add-on buys or partial exits. Therefore a position-value line can jump for reasons unrelated to price, and a P&L line requires correctly reconstructed cash flows and cost basis. This first version does not claim either.
- The existing general research chart endpoint is not reused: it does not establish exact current-position lineage, and its price-cache query is not market-scoped in this revision.

## Data contract

`GET /api/portfolio/position-history?market=us|india&positionIds=<comma-separated UUIDs>`

Response:

```ts
{
  market: "us" | "india";
  series: Record<string, {
    symbol: string;
    points: Array<{
      sessionDate: string;
      markPrice: number;
      returnPctFromFirstMark: number;
      provenance: "live_quote" | "carry_forward" | "entry_cost";
      stale: boolean;
      source: string;
    }>;
    asOf: string | null;
    truncated?: boolean;
    status: "ready" | "insufficient_history" | "unavailable";
  }>;
}
```

The endpoint authenticates viewer/owner, caps requests to eight IDs, loads the current open positions for the requested market first, and returns histories only for those verified IDs. It filters every mark query by both market and current position IDs, pages newest marks first up to a hard 10,000-row limit, restores chronological order in the derived series, and labels a capped history rather than implying it contains the entire life of the position. It does not disclose unrelated owner positions. A position with fewer than two valid distinct marks renders a neutral placeholder.

## UI

- Place the sparkline within `PositionCard`, beneath the bought/opened date and quote row.
- X axis: market session date, implicit through ordered daily points.
- Y axis: percent change from the first valid mark; include a zero baseline and signed latest percentage.
- Tooltip: session date, mark price, percentage move, and mark provenance/freshness.
- Stale/carry-forward observations are visibly muted; missing sessions remain gaps (never interpolated as fresh quotes).
- Values are raw recorded marks; corporate-action/split normalization is not claimed by this chart version.
- Preserve existing current P&L, value, exit-plan, and manual-close displays unchanged.
- Honor mobile card width and provide an accessible text summary.

## Broad-market and sizing boundary

The user-approved broad-market recommendation is to widen *measurement* before widening buys. The current cross-sectional-rank design is already measure-capable and off by default; evaluating thousands of symbols does not create thousands of independent portfolio bets. Do not turn on rank, broaden the buy list, change the max-eight limit, alter cash targets, or change sizing under this chart feature.

The sizing replay already compares equal planned allocation against equal stop-risk allocation. It must remain blocked when entry-stop provenance, partial-lot lineage, point-in-time marks, or taint reconciliation is missing. Historical sizing claims should be reported separately from chart delivery. A future broad-universe promotion requires a frozen point-in-time eligible universe, consistent market/asset-type cohorts, realistic costs and capacity, and paired out-of-sample portfolio replay against the existing screen.

The broad-market sequence is therefore:

1. Establish a point-in-time list of broker-supported, instrument-classified symbols; a current list cannot be used as historical truth.
2. Apply low-cost liquidity, price-history, spread/volume, asset-type, and data-quality screens before expensive fundamentals, news, or LLM analysis.
3. Rank only comparable market × asset-class × sector cohorts; retain the existing buy-size and candidate limits while measuring.
4. Record both current-screen candidates and incremental broad-screen finalists in a no-trade shadow with the exact as-of data and refusal reasons.
5. Compare matched portfolios on identical dates/capital/constraints after costs; report label maturity, independent sessions, overlap-adjusted evidence, drawdown, capacity and turnover.
6. Promote no broader universe or ranking rule from raw hit rate, a handful of rally examples, or in-sample parameter tuning. Promotion remains a separate owner decision after out-of-sample evidence.

## Files

- Add `app/api/portfolio/position-history/route.ts` (owner/viewer-gated read-only endpoint).
- Add `components/dashboard/PositionHistorySparkline.tsx` (read-only visualization).
- Update `components/dashboard/PortfolioPage.tsx` (batch request and per-position rendering).
- Add route/component tests under `tests/`.
- Update `docs/arch/10-current-system-reference.md` with the chart contract and limitation.
- No files in the scorer, candidate universe, constructor, or trading policy are changed by this slice.

## Acceptance and non-goals

1. A request cannot retrieve marks for a closed, unknown, or other-market position ID.
2. Responses contain only the authenticated dashboard's open positions, max eight per call.
3. No-data, one-mark, stale-mark, and mixed-provenance histories render honestly.
4. Percentage values are deterministic and use the first valid mark; no mark is fabricated or interpolated.
5. Existing position P&L and exit plan remain unchanged.
6. No database migration, provider call, portfolio policy change, order, or paper/live flag change.
