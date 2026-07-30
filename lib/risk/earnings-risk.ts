import { createHash } from "crypto";
import { fetchEarningsDateObservation } from "@/lib/data/earnings";
import { fetchWebullEarnings } from "@/lib/data/webull-data";
import { isMarketHoliday } from "@/lib/trading/market-calendar";
import { callRobinhoodResearchReadTool } from "@/lib/robinhood-mcp";

export type Market = "us" | "india";
export type ReportSession = "bmo" | "amc" | "during_session" | "unknown";

export type EarningsEventRisk = {
  market: Market;
  symbol: string;
  reportDate: string | null;
  reportSession: ReportSession;
  sessionsUntilReport: number | null;
  source: string | null;
  observedAt: string;
  confidence: "confirmed" | "estimated" | "unknown";
  status: "available" | "unknown" | "conflict";
  observations: Array<{ date: string; session: ReportSession; source: string; observedAt: string; confirmed: boolean }>;
};

export type EarningsMoveProxy = {
  market: "us";
  symbol: string;
  source: "robinhood" | "yahoo";
  observedAt: string;
  quoteAsOf: string | null;
  reportDate: string;
  reportSession: ReportSession;
  expiry: string;
  spot: number;
  strike: number;
  callBid: number;
  callAsk: number;
  putBid: number;
  putAsk: number;
  callMid: number;
  putMid: number;
  moveProxyPct: number;
  stopDistancePct: number | null;
  stopToMoveRatio: number | null;
  quality: "usable" | "wide_spread" | "stale" | "illiquid" | "unavailable";
  reason: string;
};

export type EarningsRiskAnnotation = {
  policyVersion: 1;
  policyMode: "shadow";
  market: Market;
  symbol: string;
  horizonSessions: number;
  event: EarningsEventRisk;
  moveProxy: EarningsMoveProxy | null;
  counterfactualVerdict: "allow" | "block" | "size_down" | "unknown";
  counterfactualReason: string;
  behaviorChanged: false;
};

export const EARNINGS_RISK_POLICY = {
  version: 1 as const,
  mode: "shadow" as const,
  proximitySessions: 5,
  maxLegSpreadToMid: 0.35,
  maxQuoteAgeSeconds: 15 * 60,
  minOpenInterest: 1,
};

function ymd(date: Date, market: Market): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: market === "india" ? "Asia/Kolkata" : "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function isTradingDay(market: Market, date: string): boolean {
  const d = new Date(`${date}T12:00:00Z`);
  const day = d.getUTCDay();
  return day !== 0 && day !== 6 && !isMarketHoliday(market, date);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Real calendar date (rejects 2026-02-31 and other well-formed impossibilities). */
function isRealDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Trading sessions from `from` to `to`, signed by direction. NULL means the
 * distance is UNKNOWN — never a fabricated number.
 *
 * The previous version walked a 400-iteration guard and returned whatever it had
 * counted when the target was never reached, which produced confident-looking
 * garbage: a malformed `to` gave 282, a date beyond the guard gave 282, and an
 * empty string gave -280. Both callers persist or render that value, and the
 * conflict check below compared two such numbers — so two unparseable dates
 * scored 282 each and read as AGREEING. That contradicts this feature's own rule
 * that unknown or conflicting data must never become a confident date.
 */
export function tradingSessionsBetween(market: Market, from: string, to: string): number | null {
  if (!isRealDate(from) || !isRealDate(to)) return null;
  if (from === to) return 0;
  const direction = from < to ? 1 : -1;
  const cursor = new Date(`${from}T12:00:00Z`);
  let count = 0;
  for (let guard = 0; guard < 400; guard++) {
    cursor.setUTCDate(cursor.getUTCDate() + direction);
    const date = cursor.toISOString().slice(0, 10);
    if (isTradingDay(market, date)) count += direction;
    if (date === to) return count;
  }
  return null; // target not reached inside the guard — distance is unknown
}

function normalizeSession(value: unknown): ReportSession {
  const text = String(value ?? "").toLowerCase();
  if (["bmo", "am", "before_open"].includes(text)) return "bmo";
  if (["amc", "pm", "after_close"].includes(text)) return "amc";
  if (["dmh", "during_session"].includes(text)) return "during_session";
  return "unknown";
}

let robinhoodCalendarCache: { observedAt: string; rows: any[] } | null = null;
const ROBINHOOD_CALENDAR_TTL_MS = 30 * 60 * 1000;

async function robinhoodCalendarRows(): Promise<{ observedAt: string; rows: any[] } | null> {
  if (robinhoodCalendarCache &&
      Date.now() - new Date(robinhoodCalendarCache.observedAt).getTime() < ROBINHOOD_CALENDAR_TTL_MS) {
    return robinhoodCalendarCache;
  }
  const observedAt = new Date().toISOString();
  const result = await callRobinhoodResearchReadTool("get_earnings_calendar", {
    start_date: ymd(new Date(), "us"),
    days: 31,
  });
  if (!result.ok) return null;
  const rows = (result.data as any)?.data?.results ?? [];
  if (!Array.isArray(rows)) return null;
  robinhoodCalendarCache = { observedAt, rows };
  return robinhoodCalendarCache;
}

async function robinhoodEarningsObservation(symbol: string): Promise<EarningsEventRisk["observations"][number] | null> {
  const calendar = await robinhoodCalendarRows();
  if (!calendar) return null;
  const row = calendar.rows.find((candidate: any) => String(candidate?.symbol ?? "").toUpperCase() === symbol);
  const date = String(row?.report?.date ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return {
    date,
    session: normalizeSession(row?.report?.timing),
    source: "robinhood",
    observedAt: calendar.observedAt,
    confirmed: row?.report?.verified === true,
  };
}

export async function resolveEarningsEventRisk(
  supabase: any,
  symbolInput: string,
  market: Market,
): Promise<EarningsEventRisk> {
  const symbol = symbolInput.trim().toUpperCase();
  const observedAt = new Date().toISOString();
  const today = ymd(new Date(), market);
  const cachedPromise = supabase
    .from("earnings_calendar")
    .select("report_date,report_time,announcement_session,fetched_at,actual_available_at")
    .eq("market", market)
    .eq("symbol", symbol)
    .gte("report_date", today)
    .order("report_date", { ascending: true })
    .limit(1)
    .maybeSingle()
    .then(({ data }: any) => data ? {
      date: String(data.report_date),
      session: normalizeSession(data.announcement_session ?? data.report_time),
      source: "earnings_calendar_cache",
      observedAt: String(data.fetched_at ?? observedAt),
      confirmed: Boolean(data.actual_available_at),
    } : null)
    .catch(() => null);
  const basePromise = fetchEarningsDateObservation(symbol, market).then((row) => row ? {
    date: row.date,
    session: row.session,
    source: row.source,
    observedAt: row.observedAt,
    confirmed: row.confirmed,
  } : null);
  const webullPromise = market === "us"
    ? fetchWebullEarnings(symbol).then((row) => row?.nextDate ? {
        date: String(row.nextDate).slice(0, 10),
        session: "unknown" as const,
        source: "webull",
        observedAt,
        confirmed: false,
      } : null)
    : Promise.resolve(null);
  const robinhoodPromise = market === "us" ? robinhoodEarningsObservation(symbol) : Promise.resolve(null);
  const observations = (await Promise.all([
    cachedPromise,
    basePromise,
    webullPromise,
    robinhoodPromise,
  ])).filter((row): row is EarningsEventRisk["observations"][number] => row != null);

  if (observations.length === 0) {
    return {
      market, symbol, reportDate: null, reportSession: "unknown",
      sessionsUntilReport: null, source: null, observedAt,
      confidence: "unknown", status: "unknown", observations: [],
    };
  }
  // An UNMEASURABLE gap is a conflict, not agreement. Math.abs(null) is 0, so
  // treating null as "0 sessions apart" would silently reconcile two dates whose
  // distance could not be computed at all.
  const conflict = observations.some((left) => observations.some((right) => {
    const gap = tradingSessionsBetween(market, left.date, right.date);
    return gap === null || Math.abs(gap) > 1;
  }));
  if (conflict) {
    return {
      market, symbol, reportDate: null, reportSession: "unknown",
      sessionsUntilReport: null, source: null, observedAt,
      confidence: "unknown", status: "conflict", observations,
    };
  }
  const chosen = [...observations].sort((a, b) => {
    const rank = (row: typeof a) => row.confirmed ? 0 : row.source === "robinhood" ? 1
      : row.source === "earnings_calendar_cache" ? 2 : row.source === "webull" ? 3 : 4;
    return rank(a) - rank(b);
  })[0];
  return {
    market,
    symbol,
    reportDate: chosen.date,
    reportSession: chosen.session,
    sessionsUntilReport: tradingSessionsBetween(market, today, chosen.date),
    source: chosen.source,
    observedAt,
    confidence: chosen.confirmed ? "confirmed" : "estimated",
    status: "available",
    observations,
  };
}

export function selectPostEventExpiry(
  expiries: string[],
  reportDate: string,
  session: ReportSession,
): string | null {
  const minimum = session === "bmo" || session === "during_session" ? reportDate : null;
  return [...expiries].sort().find((expiry) =>
    isTradingDay("us", expiry) && (minimum ? expiry >= minimum : expiry > reportDate)) ?? null;
}

type NormalizedLeg = {
  instrumentId: string;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  openInterest: number;
  updatedAt: string | null;
};

export function calculateMoveProxy(input: {
  symbol: string;
  source: "robinhood" | "yahoo";
  reportDate: string;
  reportSession: ReportSession;
  expiry: string;
  spot: number;
  strike: number;
  call: NormalizedLeg;
  put: NormalizedLeg;
  stopDistancePct?: number | null;
  now?: Date;
}): EarningsMoveProxy {
  const observedAt = (input.now ?? new Date()).toISOString();
  const unavailable = (quality: EarningsMoveProxy["quality"], reason: string): EarningsMoveProxy => ({
    market: "us", symbol: input.symbol, source: input.source, observedAt,
    quoteAsOf: input.call.updatedAt && input.put.updatedAt
      ? (input.call.updatedAt < input.put.updatedAt ? input.call.updatedAt : input.put.updatedAt)
      : input.call.updatedAt ?? input.put.updatedAt,
    reportDate: input.reportDate, reportSession: input.reportSession,
    expiry: input.expiry, spot: input.spot, strike: input.strike,
    callBid: input.call.bid, callAsk: input.call.ask,
    putBid: input.put.bid, putAsk: input.put.ask,
    callMid: 0, putMid: 0, moveProxyPct: 0,
    stopDistancePct: input.stopDistancePct ?? null,
    stopToMoveRatio: null, quality, reason,
  });
  const finite = [input.spot, input.strike, input.call.bid, input.call.ask, input.put.bid, input.put.ask]
    .every((value) => Number.isFinite(value));
  if (!finite || input.spot <= 0 || input.call.ask < input.call.bid || input.put.ask < input.put.bid) {
    return unavailable("unavailable", "invalid_or_crossed_quote");
  }
  const callLiquidity = input.call.openInterest >= EARNINGS_RISK_POLICY.minOpenInterest ||
    input.call.bidSize > 0 || input.call.askSize > 0;
  const putLiquidity = input.put.openInterest >= EARNINGS_RISK_POLICY.minOpenInterest ||
    input.put.bidSize > 0 || input.put.askSize > 0;
  if (input.call.bid <= 0 || input.put.bid <= 0 || !callLiquidity || !putLiquidity) {
    return unavailable("illiquid", "zero_bid_size_or_open_interest");
  }
  const callMid = (input.call.bid + input.call.ask) / 2;
  const putMid = (input.put.bid + input.put.ask) / 2;
  if (callMid <= 0 || putMid <= 0) return unavailable("illiquid", "zero_mid");
  const callSpread = (input.call.ask - input.call.bid) / callMid;
  const putSpread = (input.put.ask - input.put.bid) / putMid;
  const quoteAsOf = input.call.updatedAt && input.put.updatedAt
    ? (input.call.updatedAt < input.put.updatedAt ? input.call.updatedAt : input.put.updatedAt)
    : null;
  const quoteAge = quoteAsOf ? ((input.now ?? new Date()).getTime() - new Date(quoteAsOf).getTime()) / 1000 : Infinity;
  const moveProxyPct = (callMid + putMid) / input.spot;
  const stopDistancePct = input.stopDistancePct ?? null;
  const base = {
    market: "us" as const, symbol: input.symbol, source: input.source, observedAt,
    quoteAsOf, reportDate: input.reportDate, reportSession: input.reportSession,
    expiry: input.expiry, spot: input.spot, strike: input.strike,
    callBid: input.call.bid, callAsk: input.call.ask,
    putBid: input.put.bid, putAsk: input.put.ask,
    callMid, putMid, moveProxyPct, stopDistancePct,
    stopToMoveRatio: stopDistancePct != null && moveProxyPct > 0 ? stopDistancePct / moveProxyPct : null,
  };
  if (!Number.isFinite(quoteAge) || quoteAge > EARNINGS_RISK_POLICY.maxQuoteAgeSeconds) {
    return { ...base, quality: "stale", reason: "quote_stale_or_untimestamped" };
  }
  if (callSpread > EARNINGS_RISK_POLICY.maxLegSpreadToMid || putSpread > EARNINGS_RISK_POLICY.maxLegSpreadToMid) {
    return { ...base, quality: "wide_spread", reason: "leg_spread_above_policy" };
  }
  return { ...base, quality: "usable", reason: "validated_same_expiry_same_strike_mids" };
}

export async function fetchYahooMoveProxy(input: {
  symbol: string;
  event: EarningsEventRisk;
  spot: number;
  stopDistancePct?: number | null;
}): Promise<EarningsMoveProxy | null> {
  if (input.event.status !== "available" || !input.event.reportDate) return null;
  try {
    const base = `https://query1.finance.yahoo.com/v7/finance/options/${encodeURIComponent(input.symbol)}`;
    const first = await fetch(base, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (!first.ok) return null;
    const firstJson = await first.json();
    const firstResult = firstJson?.optionChain?.result?.[0];
    const expiries = (firstResult?.expirationDates ?? [])
      .map((value: number) => new Date(value * 1000).toISOString().slice(0, 10));
    const expiry = selectPostEventExpiry(expiries, input.event.reportDate, input.event.reportSession);
    if (!expiry) return null;
    const expiryEpoch = Math.floor(Date.parse(`${expiry}T00:00:00Z`) / 1000);
    const response = await fetch(`${base}?date=${expiryEpoch}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (!response.ok) return null;
    const json = await response.json();
    const result = json?.optionChain?.result?.[0];
    const option = result?.options?.find((row: any) =>
      new Date(Number(row?.expirationDate ?? 0) * 1000).toISOString().slice(0, 10) === expiry)
      ?? result?.options?.[0];
    const calls: any[] = option?.calls ?? [];
    const puts: any[] = option?.puts ?? [];
    const callByStrike = new Map(calls.map((row) => [String(row.strike), row]));
    const pairs = puts
      .filter((put) => callByStrike.has(String(put.strike)))
      .map((put) => ({ strike: Number(put.strike), put, call: callByStrike.get(String(put.strike)) }))
      .filter((pair) => Number.isFinite(pair.strike))
      .sort((a, b) => Math.abs(a.strike - input.spot) - Math.abs(b.strike - input.spot));
    const pair = pairs[0];
    if (!pair) return null;
    const quoteAt = Number(result?.quote?.regularMarketTime);
    const updatedAt = Number.isFinite(quoteAt) && quoteAt > 0 ? new Date(quoteAt * 1000).toISOString() : null;
    const leg = (row: any): NormalizedLeg => ({
      instrumentId: String(row.contractSymbol ?? ""),
      bid: Number(row.bid),
      ask: Number(row.ask),
      bidSize: Number(row.bidSize ?? 0),
      askSize: Number(row.askSize ?? 0),
      openInterest: Number(row.openInterest ?? 0),
      updatedAt,
    });
    return calculateMoveProxy({
      symbol: input.symbol,
      source: "yahoo",
      reportDate: input.event.reportDate,
      reportSession: input.event.reportSession,
      expiry,
      spot: input.spot,
      strike: pair.strike,
      call: leg(pair.call),
      put: leg(pair.put),
      stopDistancePct: input.stopDistancePct,
    });
  } catch {
    return null;
  }
}

function cursorFromNext(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try { return new URL(value).searchParams.get("cursor"); } catch { return null; }
}

export async function fetchRobinhoodMoveProxy(input: {
  symbol: string;
  event: EarningsEventRisk;
  spot: number;
  stopDistancePct?: number | null;
}): Promise<EarningsMoveProxy | null> {
  if (input.event.status !== "available" || !input.event.reportDate) return null;
  const chains = await callRobinhoodResearchReadTool("get_option_chains", { underlying_symbol: input.symbol });
  if (!chains.ok) return null;
  const chain = (chains.data as any)?.data?.chains?.[0];
  const expiry = selectPostEventExpiry(chain?.expiration_dates ?? [], input.event.reportDate, input.event.reportSession);
  if (!chain || !expiry) return null;

  const instruments: any[] = [];
  let cursor: string | null = null;
  let hasMore = false;
  for (let page = 0; page < 5; page++) {
    const result = await callRobinhoodResearchReadTool("get_option_instruments", {
      chain_symbol: input.symbol,
      expiration_dates: expiry,
      state: "active",
      ...(cursor ? { cursor } : {}),
    });
    if (!result.ok) return null;
    const payload = (result.data as any)?.data;
    instruments.push(...(payload?.instruments ?? []));
    cursor = cursorFromNext(payload?.next);
    hasMore = Boolean(cursor);
    const commonStrikes = new Set(instruments.filter((row) => row.type === "call").map((row) => row.strike_price));
    const highestCommon = Math.max(...instruments
      .filter((row) => row.type === "put" && commonStrikes.has(row.strike_price))
      .map((row) => Number(row.strike_price))
      .filter(Number.isFinite));
    if (!cursor || highestCommon >= input.spot) break;
  }

  const pairs = new Map<string, { call?: any; put?: any }>();
  for (const row of instruments) {
    if (row.expiration_date !== expiry) continue;
    const pair = pairs.get(row.strike_price) ?? {};
    if (row.type === "call") pair.call = row;
    if (row.type === "put") pair.put = row;
    pairs.set(row.strike_price, pair);
  }
  const complete = [...pairs.entries()].filter(([, pair]) => pair.call && pair.put);
  const maxStrike = Math.max(...complete.map(([strike]) => Number(strike)).filter(Number.isFinite));
  if (hasMore && maxStrike < input.spot) return null;
  const selected = complete.sort((a, b) =>
    Math.abs(Number(a[0]) - input.spot) - Math.abs(Number(b[0]) - input.spot))[0];
  if (!selected) return null;
  const quotes = await callRobinhoodResearchReadTool("get_option_quotes", {
    instrument_ids: [selected[1].call.id, selected[1].put.id],
  });
  if (!quotes.ok) return null;
  const rows = (quotes.data as any)?.data?.results ?? [];
  const byId = new Map(rows.map((row: any) => [row?.quote?.instrument_id, row?.quote]));
  const leg = (instrument: any): NormalizedLeg | null => {
    const quote: any = byId.get(instrument.id);
    if (!quote) return null;
    return {
      instrumentId: instrument.id,
      bid: Number(quote.bid_price),
      ask: Number(quote.ask_price),
      bidSize: Number(quote.bid_size ?? 0),
      askSize: Number(quote.ask_size ?? 0),
      openInterest: Number(quote.open_interest ?? 0),
      updatedAt: typeof quote.updated_at === "string" ? quote.updated_at : null,
    };
  };
  const call = leg(selected[1].call);
  const put = leg(selected[1].put);
  if (!call || !put) return null;
  return calculateMoveProxy({
    symbol: input.symbol, source: "robinhood",
    reportDate: input.event.reportDate, reportSession: input.event.reportSession,
    expiry, spot: input.spot, strike: Number(selected[0]), call, put,
    stopDistancePct: input.stopDistancePct,
  });
}

export function earningsRiskVerdict(
  event: EarningsEventRisk,
  moveProxy: EarningsMoveProxy | null,
  horizonSessions: number,
): Pick<EarningsRiskAnnotation, "counterfactualVerdict" | "counterfactualReason" | "behaviorChanged"> {
  if (event.status !== "available" || event.sessionsUntilReport == null) {
    return { counterfactualVerdict: "unknown", counterfactualReason: `earnings_${event.status}`, behaviorChanged: false };
  }
  if (event.sessionsUntilReport < 0 || event.sessionsUntilReport > horizonSessions) {
    return { counterfactualVerdict: "allow", counterfactualReason: "event_outside_horizon", behaviorChanged: false };
  }
  if (!moveProxy || moveProxy.quality !== "usable") {
    return { counterfactualVerdict: "unknown", counterfactualReason: `move_proxy_${moveProxy?.quality ?? "unavailable"}`, behaviorChanged: false };
  }
  if (moveProxy.stopToMoveRatio != null && moveProxy.stopToMoveRatio < 1) {
    return { counterfactualVerdict: "size_down", counterfactualReason: "planned_stop_inside_move_proxy", behaviorChanged: false };
  }
  return { counterfactualVerdict: "allow", counterfactualReason: "event_risk_measured", behaviorChanged: false };
}

export async function annotateEarningsRisk(input: {
  supabase: any;
  symbol: string;
  market: Market;
  horizonSessions: number;
  spot: number;
  stopDistancePct?: number | null;
}): Promise<EarningsRiskAnnotation> {
  const symbol = input.symbol.trim().toUpperCase();
  const event = await resolveEarningsEventRisk(input.supabase, symbol, input.market);
  const relevant = event.status === "available" && event.sessionsUntilReport != null
    && event.sessionsUntilReport >= 0 && event.sessionsUntilReport <= input.horizonSessions;
  let moveProxy: EarningsMoveProxy | null = null;
  if (input.market === "us" && relevant) {
    moveProxy = await fetchRobinhoodMoveProxy({
      symbol, event, spot: input.spot, stopDistancePct: input.stopDistancePct,
    }).catch(() => null);
    if (!moveProxy) {
      moveProxy = await fetchYahooMoveProxy({
        symbol, event, spot: input.spot, stopDistancePct: input.stopDistancePct,
      }).catch(() => null);
    }
  }
  return {
    policyVersion: EARNINGS_RISK_POLICY.version,
    policyMode: EARNINGS_RISK_POLICY.mode,
    market: input.market,
    symbol,
    horizonSessions: input.horizonSessions,
    event,
    moveProxy,
    ...earningsRiskVerdict(event, moveProxy, input.horizonSessions),
  };
}

export function earningsRiskIdempotencyKey(input: {
  environment: string;
  decisionKind: string;
  signalId?: string | null;
  symbol: string;
  market: Market;
  observedSession: string;
}): string {
  return createHash("sha256").update([
    "earnings-risk-v1", input.environment, input.decisionKind,
    input.signalId ?? "none", input.market, input.symbol, input.observedSession,
  ].join("|")).digest("hex");
}

export async function recordEarningsRiskObservation(
  supabase: any,
  input: {
    environment: "paper" | "live" | "position" | "probe";
    decisionKind: "entry" | "rotation" | "holding" | "contract_probe";
    signalId?: string | null;
    proposalId?: string | null;
    annotation: EarningsRiskAnnotation;
    legacyGateBlocked?: boolean;
  },
): Promise<void> {
  const observedSession = ymd(new Date(input.annotation.event.observedAt), input.annotation.market);
  const key = earningsRiskIdempotencyKey({
    environment: input.environment,
    decisionKind: input.decisionKind,
    signalId: input.signalId,
    symbol: input.annotation.symbol,
    market: input.annotation.market,
    observedSession,
  });
  const proxy = input.annotation.moveProxy;
  const { error } = await supabase.from("earnings_risk_observations").upsert({
    idempotency_key: key,
    market: input.annotation.market,
    environment: input.environment,
    decision_kind: input.decisionKind,
    signal_id: input.signalId ?? null,
    proposal_id: input.proposalId ?? null,
    symbol: input.annotation.symbol,
    observed_at: input.annotation.event.observedAt,
    report_date: input.annotation.event.reportDate,
    report_session: input.annotation.event.reportSession,
    sessions_until_report: input.annotation.event.sessionsUntilReport,
    earnings_status: input.annotation.event.status,
    earnings_source: input.annotation.event.source,
    earnings_confidence: input.annotation.event.confidence,
    options_source: proxy?.source ?? null,
    options_quality: proxy?.quality ?? "unavailable",
    expiry: proxy?.expiry ?? null,
    quote_as_of: proxy?.quoteAsOf ?? null,
    spot: proxy?.spot ?? null,
    strike: proxy?.strike ?? null,
    call_bid: proxy?.callBid ?? null,
    call_ask: proxy?.callAsk ?? null,
    put_bid: proxy?.putBid ?? null,
    put_ask: proxy?.putAsk ?? null,
    move_proxy_pct: proxy?.moveProxyPct ?? null,
    stop_distance_pct: proxy?.stopDistancePct ?? null,
    stop_to_move_ratio: proxy?.stopToMoveRatio ?? null,
    policy_version: input.annotation.policyVersion,
    policy_mode: input.annotation.policyMode,
    counterfactual_verdict: input.annotation.counterfactualVerdict,
    counterfactual_reason: input.annotation.counterfactualReason,
    behavior_changed: false,
    legacy_gate_blocked: input.legacyGateBlocked ?? false,
    source_observations: input.annotation.event.observations,
  }, { onConflict: "idempotency_key", ignoreDuplicates: true });
  if (error && !/relation .* does not exist/i.test(error.message)) {
    throw new Error(`earnings_risk_observation_failed:${error.message}`);
  }
}
