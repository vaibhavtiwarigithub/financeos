import type { BriefingRiskAccount, BriefingRiskHolding, LiveRiskRunRow } from "@/lib/briefing/live-risk";

export type BriefingMarket = "us" | "india";

export function escapeLedgerHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface PaperLedgerRow {
  symbol: string;
  market: string;
  qty: number | null;
  avgCost: number | null;
  mark: number | null;
  marketValue: number | null;
  pnl: number | null;
  pnlPct: number | null;
  stop: number | null;
  target: number | null;
  openedAt: string | null;
  markUpdatedAt: string | null;
}

function finite(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function normalizePaperLedger(rows: readonly any[], market: BriefingMarket): PaperLedgerRow[] {
  return rows
    .filter((row) => row?.market === market)
    // A row in paper_positions is a live lot. Closed lots leave this table via
    // the transactional exit RPC; exit_reason can also hold an armed exit flag.
    .map((row): PaperLedgerRow => {
      const symbol = typeof row.symbol === "string" && row.symbol.trim() ? row.symbol.trim() : "Symbol unavailable";
      const qty = finite(row.qty);
      const avgCost = finite(row.avg_cost);
      const mark = finite(row.current_price);
      const pnl = qty != null && qty > 0 && avgCost != null && avgCost > 0 && mark != null
        ? (mark - avgCost) * qty
        : null;
      const pnlPct = avgCost != null && avgCost > 0 && mark != null
        ? ((mark - avgCost) / avgCost) * 100
        : null;
      return {
        symbol,
        market,
        qty,
        avgCost,
        mark,
        // Paper rows do not persist market_value; calculate this deterministic
        // valuation only when its two authoritative inputs are present.
        marketValue: qty != null && mark != null ? qty * mark : null,
        pnl,
        pnlPct,
        stop: finite(row.stop_loss),
        target: finite(row.price_target),
        openedAt: typeof row.opened_at === "string" ? row.opened_at : null,
        markUpdatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
      };
    });
}

export function paperLedgerLines(rows: readonly PaperLedgerRow[], currency: string): string[] {
  return rows.map((row) => {
    const money = (n: number | null) => n == null ? "unavailable" : `${currency}${n.toFixed(2)}`;
    const signedPnl = row.pnl == null ? "unavailable" : `${row.pnl >= 0 ? "+" : "−"}${currency}${Math.abs(row.pnl).toFixed(2)}`;
    const pnl = row.pnl == null ? "P&L unavailable" : `P&L ${signedPnl} (${row.pnlPct == null ? "n/a" : `${row.pnlPct >= 0 ? "+" : ""}${row.pnlPct.toFixed(1)}%`})`;
    return `  • ${row.symbol}: ${row.qty ?? "unavailable"} shares @ ${money(row.avgCost)} entry; stored mark ${money(row.mark)}; ${pnl}; stop ${money(row.stop)}; target ${money(row.target)}; mark row updated ${row.markUpdatedAt ?? "time unavailable"}`;
  });
}

export interface LiveLedgerAccount {
  accountId: string;
  label: string;
  broker: string;
  currency: "USD" | "INR";
  capturedAt: string | null;
  totalValue: number | null;
  holdings: BriefingRiskHolding[];
  snapshotStatus: string;
  coverageNote: string | null;
}

function runTime(run: LiveRiskRunRow): number {
  const ts = run.started_at ?? run.completed_at ?? `${run.captured_on}T00:00:00Z`;
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : 0;
}

function maskedAccountLabel(run: LiveRiskRunRow): string {
  const last4 = run.account_id.slice(-4);
  const fallback = `${run.broker} ••••${last4}`;
  return run.account_label ? run.account_label.split(run.account_id).join(`••••${last4}`) : fallback;
}

export function normalizeLiveLedger(
  accounts: readonly BriefingRiskAccount[],
  market: BriefingMarket,
  runs: readonly LiveRiskRunRow[] = [],
): LiveLedgerAccount[] {
  const currency: "INR" | "USD" = market === "india" ? "INR" : "USD";
  const scopedRuns = runs.filter((run) => run.market === market && run.currency === currency && run.broker !== "internal");
  const latestAttempt = new Map<string, LiveRiskRunRow>();
  for (const run of scopedRuns) {
    const prior = latestAttempt.get(run.account_id);
    if (!prior || runTime(run) > runTime(prior)) latestAttempt.set(run.account_id, run);
  }
  const completed = accounts
    .filter((account) => account.currency === currency && account.broker !== "internal")
    .map((account) => {
      const attempt = latestAttempt.get(account.accountId);
      return {
        accountId: account.accountId,
        label: account.accountLabel,
        broker: account.broker,
        currency,
        capturedAt: account.sourceCapturedAt,
        totalValue: account.totalValue,
        holdings: account.allHoldings,
        snapshotStatus: "complete",
        coverageNote: attempt && attempt.status !== "complete"
          ? `Latest capture attempt is ${attempt.status}; these rows are the last complete snapshot.`
          : account.stale ? "Last complete snapshot is stale by market-session age." : null,
      };
    });
  const completedIds = new Set(completed.map((account) => account.accountId));
  const incomplete = Array.from(latestAttempt.values())
    .filter((run) => run.status !== "complete" && !completedIds.has(run.account_id))
    .map((run) => ({
      accountId: run.account_id,
      label: maskedAccountLabel(run),
      broker: run.broker,
      currency,
      capturedAt: run.source_captured_at ?? run.started_at ?? null,
      totalValue: null,
      holdings: [],
      snapshotStatus: run.status,
      coverageNote: `Latest holdings capture is ${run.status}; no position list is claimed for this account.`,
    }));
  return [...completed, ...incomplete].sort((a, b) => a.broker.localeCompare(b.broker) || a.accountId.localeCompare(b.accountId));
}
