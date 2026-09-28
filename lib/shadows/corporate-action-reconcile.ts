import type { YahooCorporateAction } from "@/lib/data/yahoo-candles";
import type { AtrStopReplayCorporateAction } from "@/lib/shadows/atr-stop-forward-replay";

export interface CorporateActionLedgerRow {
  symbol: string;
  action_type: string;
  ex_date: string;
  split_ratio?: number | string | null;
  dividend_amount?: number | string | null;
}

export interface CorporateActionCoverageRow {
  symbol: string;
  action_type: string;
  status: string;
  checked_at: string;
  provider_fetched_at: string | null;
  records_count: number;
}

export interface CorporateActionReconciliation {
  actions: AtrStopReplayCorporateAction[] | null;
  blockers: string[];
}

const sameAmount = (left: unknown, right: unknown) => {
  const a = Number(left), b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= Math.max(0.0001, Math.abs(a) * 0.00001);
};

/**
 * Reconcile each replay-session Yahoo action against a fresh, successfully
 * fetched Alpha Vantage action ledger. A missing coverage row is not an empty
 * action list. Returns no actions at all if any symbol/type cannot be proven.
 */
export function reconcileCorporateActionsForSession(input: {
  symbols: string[];
  session: string;
  yahooActions: YahooCorporateAction[];
  ledgerRows: CorporateActionLedgerRow[];
  coverageRows: CorporateActionCoverageRow[];
  now?: Date;
  maxCoverageAgeDays?: number;
}): CorporateActionReconciliation {
  const now = (input.now ?? new Date()).getTime();
  const maxAgeMs = (input.maxCoverageAgeDays ?? 30) * 86_400_000;
  const symbols = [...new Set(input.symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))].sort();
  const blockers: string[] = [];
  const actions: AtrStopReplayCorporateAction[] = [];

  for (const symbol of symbols) {
    for (const kind of ["split", "dividend"] as const) {
      const coverage = input.coverageRows
        .filter((row) => row.symbol.trim().toUpperCase() === symbol && row.action_type === kind)
        .sort((a, b) => Date.parse(b.checked_at) - Date.parse(a.checked_at))[0];
      const fetchedAt = coverage?.provider_fetched_at ? Date.parse(coverage.provider_fetched_at) : Number.NaN;
      const checkedAt = coverage?.checked_at ? Date.parse(coverage.checked_at) : Number.NaN;
      if (!coverage || coverage.status !== "complete" || !Number.isFinite(fetchedAt) || !Number.isFinite(checkedAt)
        || fetchedAt > now + 60_000 || checkedAt > now + 60_000 || now - fetchedAt > maxAgeMs || now - checkedAt > maxAgeMs) {
        blockers.push(`${symbol}:${kind} lacks fresh complete source coverage.`);
        continue;
      }

      const yahoo = input.yahooActions.filter((row) => row.symbol.trim().toUpperCase() === symbol && row.session === input.session && row.type === kind);
      const ledger = input.ledgerRows.filter((row) => row.symbol.trim().toUpperCase() === symbol && row.ex_date === input.session && row.action_type === kind);
      if (yahoo.length > 1 || ledger.length > 1) {
        blockers.push(`${symbol}:${kind} has duplicate same-session source events.`);
        continue;
      }
      if (yahoo.length !== ledger.length) {
        blockers.push(`${symbol}:${kind} disagrees between raw-bar provider and persisted action ledger for ${input.session}.`);
        continue;
      }
      if (!yahoo.length) continue; // Fresh, complete sources both certify no event this session.

      const providerAction = yahoo[0];
      const storedAction = ledger[0];
      const amountMatches = kind === "split"
        ? sameAmount(providerAction.splitRatio, storedAction.split_ratio)
        : sameAmount(providerAction.dividendPerShare, storedAction.dividend_amount);
      if (!amountMatches) {
        blockers.push(`${symbol}:${kind} terms disagree between raw-bar provider and persisted action ledger for ${input.session}.`);
        continue;
      }
      actions.push(kind === "split"
        ? { symbol, session: input.session, type: "split", splitRatio: Number(providerAction.splitRatio) }
        : { symbol, session: input.session, type: "dividend", dividendPerShare: Number(providerAction.dividendPerShare) });
    }
  }

  return blockers.length ? { actions: null, blockers } : { actions, blockers: [] };
}
