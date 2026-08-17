export type TradingMarket = "us" | "india";
export type HorizonStyle = "short_swing" | "swing" | "position";
export type StrategyPreference = "adaptive" | "momentum" | "balanced" | "value_quality";
export type HorizonGovernance = "user" | "agent";
export type ExistingPositionsPolicy = "grandfather" | "apply";

export interface TradingMandate {
  market: TradingMarket;
  horizon_style: HorizonStyle;
  strategy_preference: StrategyPreference;
  horizon_governance: HorizonGovernance;
  min_hold_days: number;
  target_hold_days: number;
  max_hold_days: number;
  score_threshold: number;
  max_open_positions: number;
  max_signal_age_sessions: number;
  stop_loss_pct: number;
  target_pct: number;
  existing_positions_policy: ExistingPositionsPolicy;
  version: number;
  source: "database" | "default";
}

type MandatePreset = Pick<TradingMandate,
  "min_hold_days" | "target_hold_days" | "max_hold_days" |
  "score_threshold" | "stop_loss_pct" | "target_pct">;

export const HORIZON_PRESETS: Record<HorizonStyle, MandatePreset> = {
  short_swing: { min_hold_days: 2, target_hold_days: 5, max_hold_days: 5, score_threshold: 65, stop_loss_pct: 5, target_pct: 12 },
  swing:       { min_hold_days: 5, target_hold_days: 10, max_hold_days: 15, score_threshold: 60, stop_loss_pct: 7, target_pct: 8 },
  position:    { min_hold_days: 10, target_hold_days: 20, max_hold_days: 20, score_threshold: 58, stop_loss_pct: 10, target_pct: 30 },
};

export const STRATEGY_TILTS: Record<StrategyPreference, Record<string, number>> = {
  adaptive:      { fundamental: 1, technical: 1, sentiment: 1, macro: 1, insider: 1 },
  balanced:      { fundamental: 1, technical: 1, sentiment: 1, macro: 1, insider: 1 },
  momentum:      { fundamental: 0.85, technical: 1.25, sentiment: 1.10, macro: 1, insider: 1 },
  value_quality: { fundamental: 1.30, technical: 0.85, sentiment: 0.85, macro: 1, insider: 1.10 },
};

export function defaultMandate(market: TradingMarket): TradingMandate {
  return {
    market,
    horizon_style: "swing",
    strategy_preference: "balanced",
    horizon_governance: "user",
    ...HORIZON_PRESETS.swing,
    max_open_positions: 10,
    max_signal_age_sessions: 2,
    existing_positions_policy: "grandfather",
    version: 1,
    source: "default",
  };
}

function validNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function hydrateMandate(market: TradingMarket, row: any): TradingMandate {
  const fallback = defaultMandate(market);
  if (!row) return fallback;
  const style: HorizonStyle = row.horizon_style in HORIZON_PRESETS ? row.horizon_style : fallback.horizon_style;
  const preset = HORIZON_PRESETS[style];
  const min = Math.max(2, Math.min(20, Math.round(validNumber(row.min_hold_days, preset.min_hold_days))));
  const max = Math.max(min, Math.min(20, Math.round(validNumber(row.max_hold_days, preset.max_hold_days))));
  const target = Math.max(min, Math.min(max, Math.round(validNumber(row.target_hold_days, preset.target_hold_days))));
  return {
    market,
    horizon_style: style,
    strategy_preference: row.strategy_preference in STRATEGY_TILTS ? row.strategy_preference : fallback.strategy_preference,
    horizon_governance: row.horizon_governance === "agent" ? "agent" : "user",
    min_hold_days: min,
    target_hold_days: target,
    max_hold_days: max,
    score_threshold: Math.max(0, Math.min(100, validNumber(row.score_threshold, preset.score_threshold))),
    max_open_positions: Math.max(1, Math.min(50, Math.round(validNumber(row.max_open_positions, fallback.max_open_positions)))),
    max_signal_age_sessions: Math.max(0, Math.min(10, Math.round(validNumber(row.max_signal_age_sessions, fallback.max_signal_age_sessions)))),
    stop_loss_pct: Math.max(1, Math.min(30, validNumber(row.stop_loss_pct, preset.stop_loss_pct))),
    target_pct: Math.max(1, Math.min(100, validNumber(row.target_pct, preset.target_pct))),
    existing_positions_policy: row.existing_positions_policy === "apply" ? "apply" : "grandfather",
    version: Math.max(1, Math.round(validNumber(row.version, 1))),
    source: "database",
  };
}

export async function loadTradingMandate(supabase: any, market: TradingMarket): Promise<TradingMandate> {
  try {
    const { data, error } = await supabase.from("trading_mandates").select("*").eq("market", market).maybeSingle();
    if (error) return defaultMandate(market);
    return hydrateMandate(market, data);
  } catch {
    return defaultMandate(market);
  }
}

export async function loadTradingMandateStrict(supabase: any, market: TradingMarket): Promise<TradingMandate> {
  const { data, error } = await supabase.from("trading_mandates").select("*").eq("market", market).maybeSingle();
  if (error) throw new Error(`trading mandate read failed for ${market}: ${error.message}`);
  if (!data) throw new Error(`trading mandate missing for ${market}`);
  return hydrateMandate(market, data);
}

export function resolveHorizonDays(mandate: TradingMandate, championDays?: number | null): { days: number; source: "user" | "champion" } {
  if (mandate.horizon_governance === "agent" && Number.isFinite(championDays)) {
    const days = Math.max(mandate.min_hold_days, Math.min(mandate.max_hold_days, Math.round(Number(championDays))));
    return { days, source: "champion" };
  }
  return { days: mandate.target_hold_days, source: "user" };
}

export function applyStrategyTilt<T extends string>(
  weights: Record<T, number>,
  preference: StrategyPreference,
): Record<T, number> {
  const tilt = STRATEGY_TILTS[preference];
  const out = {} as Record<T, number>;
  for (const key of Object.keys(weights) as T[]) out[key] = weights[key] * (tilt[key] ?? 1);
  return out;
}

export function tradingWeekdaysBetween(start: Date, end: Date): number {
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return 0;
  const cursor = new Date(start);
  cursor.setUTCHours(0, 0, 0, 0);
  const finish = new Date(end);
  finish.setUTCHours(0, 0, 0, 0);
  let days = 0;
  while (cursor < finish) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) days++;
  }
  return days;
}

export function mandateSnapshot(m: TradingMandate, resolvedHorizonDays: number) {
  return { ...m, resolved_horizon_days: resolvedHorizonDays };
}
