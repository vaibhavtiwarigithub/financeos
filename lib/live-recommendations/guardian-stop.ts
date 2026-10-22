import type { GuardianOutcomeHorizon, GuardianOutcomeRow, GuardianOutcomeSummary, GuardianResponseEvidence, GuardianStopContract, GuardianStopOutcome } from "@/types";
import { getMarketDayStatus, researchSessionCloseAt } from "@/lib/trading/market-calendar";
import type { Bar } from "./core";

export const GUARDIAN_HORIZONS = [2, 5, 10, 20] as const;
export const GUARDIAN_VERSION = "guardian_exact_stop_v1";
export type StopRecommendation = {
  id: number; market: "us" | "india"; account_id: string; symbol: string; issued_at: string;
  level_price: number | null; qty_suggested: number | null; source_table: string; source_id: string;
  guardian_contract: GuardianStopContract | null;
};
const finitePositive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
export function guardianIssueDate(market: "us" | "india", timestamp: string): string | null {
  if (!Number.isFinite(Date.parse(timestamp))) return null;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: market === "us" ? "America/New_York" : "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(timestamp));
  const p = (key: string) => parts.find(x => x.type === key)?.value;
  return `${p("year")}-${p("month")}-${p("day")}`;
}
export function guardianSessions(market: "us" | "india", issuedAt: string, horizon: number): string[] | null {
  const date = guardianIssueDate(market, issuedAt);
  if (!date) return null;
  const cursor = new Date(`${date}T12:00:00Z`); const sessions: string[] = [];
  for (let n = 0; n < 70 && sessions.length < horizon; n++) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const state = getMarketDayStatus(market, cursor);
    if (!state.calendarSupported || state.kind === "special_session") return null;
    if (state.kind === "trading_day") sessions.push(cursor.toISOString().slice(0, 10));
  }
  return sessions.length === horizon ? sessions : null;
}
export function validGuardianContract(rec: StopRecommendation): boolean {
  const c = rec.guardian_contract;
  return !!c && c.version === GUARDIAN_VERSION && c.reference_basis === "next_session_open"
    && c.extra_sell_cost_bps === 10 && !!c.episode_key && !!c.source_version
    && Number.isFinite(Date.parse(c.captured_at)) && Date.parse(c.captured_at) === Date.parse(rec.issued_at);
}

/** First suggestion per episode; disjoint 20-session windows within each account/symbol. Not an independence claim. */
export function guardianOverlapExclusions(recs: StopRecommendation[]): Map<number, string> {
  const excluded = new Map<number, string>(); const episodes = new Set<string>(); const until = new Map<string, string>();
  for (const rec of [...recs].sort((a, b) => Date.parse(a.issued_at) - Date.parse(b.issued_at) || a.id - b.id)) {
    if (!validGuardianContract(rec)) continue;
    const key = `${rec.market}:${rec.account_id}:${rec.symbol}`;
    const episode = `${key}:${rec.guardian_contract!.episode_key}`;
    const date = guardianIssueDate(rec.market, rec.issued_at)!;
    if (episodes.has(episode) || date <= (until.get(key) ?? "")) { excluded.set(rec.id, "Revision/repeat overlaps the first frozen suggestion's 20-session window."); continue; }
    episodes.add(episode);
    until.set(key, guardianSessions(rec.market, rec.issued_at, 20)?.at(-1) ?? "9999-12-31");
  }
  return excluded;
}

export function evaluateGuardianStop(rec: StopRecommendation, bars: Bar[], horizon: GuardianOutcomeHorizon, asOf: Date, excluded?: string, corporateActionDates: string[] = []): GuardianStopOutcome {
  const fail = (state: GuardianStopOutcome["state"], reason: string): GuardianStopOutcome => ({ horizon, state, reason });
  if (!rec.guardian_contract) return fail("legacy", "No frozen issue-time contract; excluded from exact-stop performance.");
  if (!validGuardianContract(rec) || !finitePositive(rec.level_price)) return fail("missing_data", "Invalid frozen stop contract or stop price.");
  if (excluded) return fail("excluded_overlap", excluded);
  const dates = guardianSessions(rec.market, rec.issued_at, horizon);
  if (!dates) return fail("missing_data", "Market calendar does not support the full window.");
  const endAt = researchSessionCloseAt(rec.market, dates.at(-1)!);
  if (endAt == null) return fail("missing_data", "Unknown horizon close.");
  if (endAt > asOf.getTime()) return fail("immature", "The full horizon has not closed.");
  const issueDate = guardianIssueDate(rec.market, rec.issued_at)!;
  if (corporateActionDates.some(d => d >= issueDate && d <= dates.at(-1)!)) return fail("excluded_corporate_action", "Corporate-action window: cash/share adjustment is not verified; excluded by this fixed contract, not a failed collector.");
  const used: Bar[] = [];
  for (const date of dates) {
    const matches = bars.filter(b => b.date === date);
    if (matches.length !== 1) return fail("missing_data", `Missing or duplicate daily bar: ${date}`);
    const b = matches[0];
    if (![b.open, b.high, b.low, b.close].every(finitePositive) || b.low > Math.min(b.open, b.close) || b.high < Math.max(b.open, b.close) || b.low > b.high)
      return fail("missing_data", `Invalid OHLC: ${date}`);
    used.push(b);
  }
  const reference = used[0].open; const hold = used.at(-1)!.close;
  let fill: number | null = null; let touchedOn: string | null = null;
  let holdPeak = reference; let stopPeak = reference; let holdDrawdown = 0; let stopDrawdown = 0;
  for (const b of used) {
    // Conservative daily drawdown bound assumes the high preceded the low.
    holdPeak = Math.max(holdPeak, b.high); holdDrawdown = Math.min(holdDrawdown, b.low / holdPeak - 1);
    if (fill == null) {
      // Same conservative high-before-low drawdown bound in both arms.
      stopPeak = Math.max(stopPeak, b.high);
      if (b.low <= rec.level_price!) { fill = Math.min(b.open, rec.level_price!); touchedOn = b.date; }
      else stopPeak = Math.max(stopPeak, b.high);
      stopDrawdown = Math.min(stopDrawdown, (fill == null ? b.low : fill * 0.999) / stopPeak - 1);
    }
  }
  const stopEnd = fill ?? hold;
  const grossDeltaPct = (stopEnd - hold) / reference * 100;
  const netDeltaPct = ((fill == null ? hold : fill * 0.999) - hold) / reference * 100;
  const qty = finitePositive(rec.qty_suggested) ? rec.qty_suggested : null;
  return { horizon, state: "ready", reason: "Daily next-session-open replay; 10 bps extra sell cost, cash after exit, no re-entry.",
    startSession: dates[0], endSession: dates.at(-1), referencePrice: reference, holdPrice: hold,
    stopFillPrice: fill, touchedOn, holdReturnPct: (hold / reference - 1) * 100,
    stopReturnPct: (stopEnd / reference - 1) * 100, grossDeltaPct, netDeltaPct,
    monetaryDelta: qty == null ? null : netDeltaPct / 100 * reference * qty,
    notional: qty == null ? null : reference * qty, holdDrawdownPct: holdDrawdown * 100, stopDrawdownPct: stopDrawdown * 100,
    priceWindow: used };
}

export type GuardianPlanEvidence = { id: number; ledger_entry_id: number | null; market: string; account_id: string; symbol: string; status: string; trigger_proposal_id: number | null };
export type GuardianFillEvidence = { id: number; proposal_id: number | null; market: string; broker_env: string; broker_account_id: string | null; symbol: string; side: string; status: string; filled_qty: number | null; avg_fill_price: number | null; submitted_at: string | null; closed_at: string | null; broker_order_id: string | null; tainted: boolean | null };
export function guardianResponse(rec: StopRecommendation, plans: GuardianPlanEvidence[], fills: GuardianFillEvidence[], asOf: Date): GuardianResponseEvidence {
  const symbol = (s: string) => rec.market === "india" ? s.toUpperCase().replace(/\.NS$/, "") : s.toUpperCase();
  const matches = plans.filter(p => p.market === rec.market && p.account_id === rec.account_id && symbol(p.symbol) === symbol(rec.symbol)
    && (rec.source_table === "guardian_protection_plans" ? String(p.id) === rec.source_id : String(p.ledger_entry_id) === rec.source_id));
  if (matches.length !== 1) return { state: "unknown", reason: "No unambiguous linked Guardian plan and broker fill." };
  const plan = matches[0];
  const orders = fills.filter(f => plan.trigger_proposal_id != null && f.proposal_id === plan.trigger_proposal_id);
  if (!orders.length) return plan.status === "declined" ? { state: "declined", reason: "Owner declined the linked plan; not an execution outcome." }
    : plan.status === "armed" ? { state: "armed_only", reason: "Arming is not a broker fill." }
    : { state: "unknown", reason: "No linked confirmed exit fill." };
  if (orders.length !== 1) return { state: "unknown", reason: "Multiple related order records require reconciliation." };
  const f = orders[0]; const filledAt = f.closed_at;
  if (f.market !== rec.market || f.broker_env !== "live" || f.broker_account_id !== rec.account_id || symbol(f.symbol) !== symbol(rec.symbol)
    || f.side !== "sell" || !["filled", "partially_filled"].includes(f.status) || f.tainted !== false || !f.broker_order_id
    || !finitePositive(f.filled_qty) || !finitePositive(f.avg_fill_price) || !filledAt
    || !Number.isFinite(Date.parse(filledAt)) || Date.parse(filledAt) < Date.parse(rec.issued_at) || Date.parse(filledAt) > asOf.getTime()
    || !finitePositive(rec.qty_suggested) || f.filled_qty > rec.qty_suggested + 1e-6)
    return { state: "unknown", reason: "Account/symbol/time/quantity/confirmation evidence does not match." };
  return { state: f.filled_qty < rec.qty_suggested - 1e-6 ? "partial_exit" : "confirmed_exit",
    reason: "Linked broker SELL fill; proceeds, not tax-lot realized P/L or causal proof.", fillQty: f.filled_qty, fillPrice: f.avg_fill_price, filledAt };
}

export function summarizeGuardianStops(rows: GuardianOutcomeRow[]): GuardianOutcomeSummary[] {
  const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  return GUARDIAN_HORIZONS.map(horizon => {
    const all = rows.flatMap(r => r.outcomes.filter(o => o.horizon === horizon));
    const ready = all.filter(o => o.state === "ready" && Number.isFinite(o.netDeltaPct));
    const deltas = ready.map(o => o.netDeltaPct!).sort((a, b) => a - b);
    const weighted = ready.filter(o => finitePositive(o.notional) && Number.isFinite(o.monetaryDelta));
    const money = weighted.length ? weighted.reduce((s, o) => s + o.monetaryDelta!, 0) : null;
    const totalNotional = weighted.reduce((s, o) => s + o.notional!, 0);
    return { horizon, total: all.length, evaluated: ready.length, meanDeltaPct: mean(deltas),
      medianDeltaPct: deltas.length ? (deltas[Math.floor((deltas.length - 1) / 2)] + deltas[Math.floor(deltas.length / 2)]) / 2 : null,
      weightedDeltaPct: money == null || !totalNotional ? null : money / totalNotional * 100,
      savedPctPoints: deltas.reduce((s, x) => s + Math.max(0, x), 0), sacrificedPctPoints: deltas.reduce((s, x) => s + Math.max(0, -x), 0),
      monetaryDelta: money, pricedQuantityCount: weighted.length, touched: ready.filter(o => o.touchedOn).length,
      meanHoldDrawdownPct: mean(ready.map(o => o.holdDrawdownPct!)), meanStopDrawdownPct: mean(ready.map(o => o.stopDrawdownPct!)) };
  });
}
