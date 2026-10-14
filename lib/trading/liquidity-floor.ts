// India paper-entry liquidity floor. A paper fill assumes a modeled 0.05% slippage, which is only credible when the stock actually
// trades enough to absorb the order. Measured 2026-10-13: 28 of 128 India symbols (22%) turn over < INR 1 crore a day, and the
// 8 paper buys placed in them account for ALL of India's realized profit (+20,369 of +17,587 INR; the other 163 buys net -2,782).
// That pattern is what unrealistic fills in untradeable names would produce, so new India entries and top-ups need real liquidity.
//
// Applies to NEW entries and top-ups only. Exits are never blocked and existing holdings are grandfathered.

export const INDIA_MIN_AVG_TURNOVER_INR = 10_000_000; // INR 1 crore, 20-session average of close x volume
export const MAX_ADV_PARTICIPATION = 0.05; // an entry may not exceed 5% of the average daily turnover
export const ADV_LOOKBACK_SESSIONS = 20;
export const ADV_MIN_SESSIONS = 10;
/** Names below this turnover can legitimately go 30+ minutes without a trade, so a stale last-trade quote is expected, not an outage. */
export const QUIET_QUOTE_TURNOVER_INR = 50_000_000; // INR 5 crore

export interface BarRow { date: string; close: number | null; volume: number | null }
export interface AdvEstimate { avgTurnoverInr: number | null; sessions: number }

/** 20-session average of close x volume from the latest bars; null average when fewer than ADV_MIN_SESSIONS usable sessions. */
export function averageTurnover(bars: readonly BarRow[]): AdvEstimate {
  const usable = bars
    .filter((b) => b.close != null && b.volume != null && Number.isFinite(Number(b.close)) && Number(b.close) > 0 && Number.isFinite(Number(b.volume)) && Number(b.volume) >= 0)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, ADV_LOOKBACK_SESSIONS);
  if (usable.length < ADV_MIN_SESSIONS) return { avgTurnoverInr: null, sessions: usable.length };
  const total = usable.reduce((s, b) => s + Number(b.close) * Number(b.volume), 0);
  return { avgTurnoverInr: total / usable.length, sessions: usable.length };
}

export type LiquidityVerdict =
  | { ok: true }
  | { ok: false; reason: "liquidity_unknown" | "liquidity_floor" | "adv_participation"; detail: string };

/** Pre-pricing gate: is this India symbol liquid enough to be paper-traded at all? Unknown liquidity fails closed. */
export function assessLiquidityFloor(adv: AdvEstimate | undefined): LiquidityVerdict {
  if (!adv || adv.avgTurnoverInr == null) {
    return { ok: false, reason: "liquidity_unknown", detail: `only ${adv?.sessions ?? 0} usable sessions of volume (need ${ADV_MIN_SESSIONS})` };
  }
  if (adv.avgTurnoverInr < INDIA_MIN_AVG_TURNOVER_INR) {
    return { ok: false, reason: "liquidity_floor", detail: `${adv.sessions}-session average turnover INR ${(adv.avgTurnoverInr / 1e7).toFixed(2)} crore < floor ${(INDIA_MIN_AVG_TURNOVER_INR / 1e7).toFixed(2)} crore` };
  }
  return { ok: true };
}

/** Post-sizing gate: the order itself must not be a large share of a typical day's traded value. */
export function assessParticipation(adv: AdvEstimate | undefined, notionalInr: number): LiquidityVerdict {
  if (!adv || adv.avgTurnoverInr == null) return { ok: false, reason: "liquidity_unknown", detail: "average turnover unavailable" };
  const share = notionalInr / adv.avgTurnoverInr;
  if (share > MAX_ADV_PARTICIPATION) {
    return { ok: false, reason: "adv_participation", detail: `order INR ${Math.round(notionalInr)} is ${(share * 100).toFixed(1)}% of average daily turnover (max ${(MAX_ADV_PARTICIPATION * 100).toFixed(0)}%)` };
  }
  return { ok: true };
}

/** True when a stale last-trade quote on this India name is an expected consequence of thin trading rather than a data outage. */
export function isQuietNameStaleQuote(adv: AdvEstimate | undefined): boolean {
  return adv != null && adv.avgTurnoverInr != null && adv.avgTurnoverInr < QUIET_QUOTE_TURNOVER_INR;
}
