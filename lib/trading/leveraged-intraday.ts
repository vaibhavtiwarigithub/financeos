import { fetchAlpacaIexIntradayBars, type IntradayBar } from "@/lib/data/alpaca-market-data";
import { getMarketDayStatus, researchSessionCloseAt } from "./market-calendar";

export const LEVERAGED_INTRADAY_POLICY = "leveraged_intraday_opening_range_v3";
export const LEVERAGED_EXPOSURES = {
  SOXL: { proxy: "SOXX", direction: 1, opposite: "SOXS" },
  SOXS: { proxy: "SOXX", direction: -1, opposite: "SOXL" },
  TQQQ: { proxy: "QQQ", direction: 1, opposite: "SQQQ" },
  SQQQ: { proxy: "QQQ", direction: -1, opposite: "TQQQ" },
} as const;
export type LeveragedSymbol = keyof typeof LEVERAGED_EXPOSURES;
const FIVE = 300_000;
function localMinutes(now: Date) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  return Number(p.find(x => x.type === "hour")?.value) * 60 + Number(p.find(x => x.type === "minute")?.value);
}
export function leveragedPaperSessionOpen(now: Date): boolean {
  const day = getMarketDayStatus("us", now);
  const close = researchSessionCloseAt("us", day.localYmd);
  return day.kind === "trading_day" && close != null && localMinutes(now) >= 570 && now.getTime() < close;
}
export function leveragedPaperEntryWindow(now: Date): boolean {
  const close = researchSessionCloseAt("us", getMarketDayStatus("us", now).localYmd);
  return leveragedPaperSessionOpen(now) && localMinutes(now) >= 585 && close != null && now.getTime() < close - 30 * 60_000;
}
/** New intraday lots only; legacy swing positions keep their original policy. */
export function leveragedPaperExitDue(now: Date, entryPolicy: unknown, openedAt?: unknown): boolean {
  if (typeof entryPolicy !== "string" || !entryPolicy.endsWith("intraday-v3")) return false;
  const close = researchSessionCloseAt("us", getMarketDayStatus("us", now).localYmd);
  if (typeof openedAt === "string" && Number.isFinite(Date.parse(openedAt)) && leveragedPaperSessionOpen(now)
    && getMarketDayStatus("us", new Date(openedAt)).localYmd < getMarketDayStatus("us", now).localYmd) return true;
  return leveragedPaperSessionOpen(now) && close != null && now.getTime() >= close - 15 * 60_000;
}
export type IntradaySetup = { state: "ready" | "wait" | "unavailable"; reason: string; policy: string;
  atr: number; structuralStop: number; signalAt: number; session: string; evidence: Record<string, unknown> };

/** Fully closed regular-session bars only. Gaps and future rows never become zero-volume bars. */
export function evaluateLeveragedIntraday(symbol: LeveragedSymbol, etf: IntradayBar[], proxy: IntradayBar[], now: Date): IntradaySetup {
  const day = getMarketDayStatus("us", now);
  const out: IntradaySetup = { state: "unavailable", reason: "intraday_bars_missing", policy: LEVERAGED_INTRADAY_POLICY,
    atr: 0, structuralStop: 0, signalAt: 0, session: day.localYmd, evidence: { source: "alpaca_iex", partial_venue: true, proxy: LEVERAGED_EXPOSURES[symbol].proxy } };
  if (!leveragedPaperEntryWindow(now)) return { ...out, state: "wait", reason: "outside_entry_window" };
  const regular = (bars: IntradayBar[]) => bars.filter(b => {
    const at = Date.parse(b.at);
    return Number.isFinite(at) && at + FIVE <= now.getTime() && at % FIVE === 0
      && leveragedPaperSessionOpen(new Date(at));
  }).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const history = regular(etf);
  const current = history.filter(b => b.date === day.localYmd);
  const underlying = regular(proxy).filter(b => b.date === day.localYmd);
  const continuous = (bars: IntradayBar[]) => bars.length >= 3 && localMinutes(new Date(bars[0].at)) === 570
    && bars.every((b, i) => !i || Date.parse(b.at) - Date.parse(bars[i - 1].at) === FIVE)
    && now.getTime() - (Date.parse(bars.at(-1)!.at) + FIVE) <= 10 * 60_000;
  if (!continuous(current) || !continuous(underlying) || Date.parse(current.at(-1)!.at) !== Date.parse(underlying.at(-1)!.at)) return out;
  const ranges = history.map((b, i) => {
    const prev = history[i - 1];
    // Overnight gaps are measured separately, never mixed into a five-minute stop ATR.
    return prev?.date === b.date ? Math.max(b.high - b.low, Math.abs(b.high - prev.close), Math.abs(b.low - prev.close)) : b.high - b.low;
  }).slice(-14);
  if (ranges.length < 14) return { ...out, reason: "intraday_atr_warmup" };
  const atr = ranges.reduce((a, b) => a + b, 0) / 14;
  const vwap = (bars: IntradayBar[]) => {
    const volume = bars.reduce((s, b) => s + b.volume, 0);
    return volume > 0 ? bars.reduce((s, b) => s + (b.vwap ?? (b.high + b.low + b.close) / 3) * b.volume, 0) / volume : NaN;
  };
  const ev = vwap(current), pv = vwap(underlying);
  const last = current.at(-1)!, pl = underlying.at(-1)!;
  if (!(atr > 0) || !Number.isFinite(ev) || !Number.isFinite(pv) || last.volume <= 0 || pl.volume <= 0) return { ...out, reason: "intraday_volume_or_range_missing" };
  const openingHigh = Math.max(...current.slice(0, 3).map(b => b.high));
  const openingLow = Math.min(...current.slice(0, 3).map(b => b.low));
  const positive = LEVERAGED_EXPOSURES[symbol].direction === 1;
  const proxyConfirmed = positive ? pl.close > pv && pl.close > Math.max(...underlying.slice(0, 3).map(b => b.high))
    : pl.close < pv && pl.close < Math.min(...underlying.slice(0, 3).map(b => b.low));
  const structuralStop = Math.min(openingLow, ...current.slice(-3).map(b => b.low));
  // Compare identical elapsed-session windows, not morning volume with an entire day.
  const priorWindows = [...new Set(history.filter(b => b.date < day.localYmd).map(b => b.date))].sort().reverse()
    .flatMap(date => {
      const rows = history.filter(b => b.date === date).slice(0, current.length);
      if (rows.length !== current.length || localMinutes(new Date(rows[0].at)) !== 570
        || rows.some((b, i) => i > 0 && Date.parse(b.at) - Date.parse(rows[i - 1].at) !== FIVE)) return [];
      const volume = rows.reduce((sum, b) => sum + b.volume, 0);
      return volume > 0 ? [volume] : [];
    }).slice(0, 5).sort((a, b) => a - b);
  const medianVolume = priorWindows.length >= 3 ? (priorWindows[Math.floor((priorWindows.length - 1) / 2)] + priorWindows[Math.ceil((priorWindows.length - 1) / 2)]) / 2 : null;
  const relativeVolume = medianVolume == null ? null : current.reduce((sum, b) => sum + b.volume, 0) / medianVolume;
  const evidence = { ...out.evidence, bar_close_at: new Date(Date.parse(last.at) + FIVE).toISOString(), openingHigh, openingLow,
    etf_vwap: ev, proxy_vwap: pv, proxy_price: pl.close, proxy_confirmed: proxyConfirmed,
    intraday_atr14: atr, atr_method: "sma_true_range_14_excluding_overnight_gap", structural_stop: structuralStop, session_open: current[0].open,
    open_to_latest_pct: (last.close / current[0].open - 1) * 100, same_time_relative_volume: relativeVolume,
    relative_volume_sessions: priorWindows.length,
    vwap_method: [...current, ...underlying].every(b => b.vwap != null) ? "volume_weighted_bar_vwap" : "typical_price_proxy" };
  return { ...out, atr, structuralStop, signalAt: Date.parse(last.at) + FIVE, evidence,
    state: relativeVolume == null ? "unavailable" : last.close > openingHigh && last.close > ev && proxyConfirmed && relativeVolume >= 1 ? "ready" : "wait",
    reason: relativeVolume == null ? "intraday_relative_volume_warmup" : "opening_range_confirmation" };
}

export async function loadLeveragedIntradaySetup(symbol: LeveragedSymbol): Promise<IntradaySetup> {
  // Serial reads respect the shared provider pacing lease; the proxy bucket is reused by its pair.
  try {
    const etf = await fetchAlpacaIexIntradayBars(symbol);
    await new Promise(resolve => setTimeout(resolve, 400));
    const proxy = await fetchAlpacaIexIntradayBars(LEVERAGED_EXPOSURES[symbol].proxy);
    return evaluateLeveragedIntraday(symbol, etf, proxy, new Date());
  } catch {
    return evaluateLeveragedIntraday(symbol, [], [], new Date());
  }
}
