export type HedgeStateName = "off" | "armed" | "active" | "exit_pending" | "cooldown";
export type HedgeAction = "none" | "enter" | "exit";

export interface HedgeConfig {
  enabled: boolean;
  allowedSymbols: string[];
  entryDangerScore: number;
  exitDangerScore: number;
  entryConfirmations: number;
  exitConfirmations: number;
  entryReturn20Pct: number;
  entryDrawdown20Pct: number;
  maxHoldingDays: number;
  cooldownDays: number;
}

export interface HedgeState {
  state: HedgeStateName;
  entryStreak: number;
  exitStreak: number;
  activeSymbol: string | null;
  activeSince: string | null;
  cooldownUntil: string | null;
}

export interface HedgeMarketSnapshot {
  asOf: string;
  dangerScore: number;
  spyClose: number;
  spySma50: number;
  spyReturn5Pct: number;
  spyReturn20Pct: number;
  spyDrawdown20Pct: number;
  qqqReturn20Pct: number | null;
  dataFresh: boolean;
}

export interface HedgeDecision {
  action: HedgeAction;
  next: HedgeState;
  symbol: string | null;
  reason: string;
  entryCondition: boolean;
  exitCondition: boolean;
}

interface ClosePoint { date: string; close: number }

function pct(current: number, previous: number): number {
  return previous > 0 ? ((current / previous) - 1) * 100 : NaN;
}

export function buildHedgeMarketSnapshot(
  spyRows: ClosePoint[],
  qqqRows: ClosePoint[],
  dangerScore: number,
  nowIso: string,
): HedgeMarketSnapshot | null {
  const spy = spyRows
    .filter((r) => r.date && Number.isFinite(r.close) && r.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  const qqq = qqqRows
    .filter((r) => r.date && Number.isFinite(r.close) && r.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (spy.length < 50 || !Number.isFinite(dangerScore)) return null;

  const last = spy[spy.length - 1];
  const sma50 = spy.slice(-50).reduce((sum, row) => sum + row.close, 0) / 50;
  const high20 = Math.max(...spy.slice(-21).map((row) => row.close));
  const qqqReturn20 = qqq.length >= 21 ? pct(qqq.at(-1)!.close, qqq.at(-21)!.close) : null;
  const ageMs = new Date(nowIso).getTime() - new Date(`${last.date}T23:59:59Z`).getTime();

  return {
    asOf: nowIso,
    dangerScore,
    spyClose: last.close,
    spySma50: sma50,
    spyReturn5Pct: spy.length >= 6 ? pct(last.close, spy.at(-6)!.close) : NaN,
    spyReturn20Pct: pct(last.close, spy.at(-21)!.close),
    spyDrawdown20Pct: pct(last.close, high20),
    qqqReturn20Pct: qqqReturn20,
    dataFresh: Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= 5 * 86_400_000,
  };
}

function clampCount(value: number, max: number): number {
  return Math.min(Math.max(0, Math.trunc(value)), Math.max(1, Math.trunc(max)));
}

function addUtcDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + Math.max(0, Math.trunc(days)));
  return d.toISOString();
}

function normalized(state: HedgeState): HedgeState {
  return {
    state: state.state,
    entryStreak: Math.max(0, Math.trunc(state.entryStreak || 0)),
    exitStreak: Math.max(0, Math.trunc(state.exitStreak || 0)),
    activeSymbol: state.activeSymbol || null,
    activeSince: state.activeSince || null,
    cooldownUntil: state.cooldownUntil || null,
  };
}

function chooseSymbol(config: HedgeConfig, snapshot: HedgeMarketSnapshot): string | null {
  const allowed = new Set(config.allowedSymbols.map((s) => s.trim().toUpperCase()));
  if (
    allowed.has("PSQ") &&
    snapshot.qqqReturn20Pct != null &&
    snapshot.qqqReturn20Pct <= snapshot.spyReturn20Pct - 3
  ) return "PSQ";
  return allowed.has("SH") ? "SH" : null;
}

export function evaluateDownsideHedge(
  config: HedgeConfig,
  current: HedgeState,
  snapshot: HedgeMarketSnapshot,
): HedgeDecision {
  const state = normalized(current);
  const now = new Date(snapshot.asOf).getTime();

  if (!config.enabled) {
    return {
      action: "none",
      next: { state: "off", entryStreak: 0, exitStreak: 0, activeSymbol: null, activeSince: null, cooldownUntil: null },
      symbol: null,
      reason: "disabled",
      entryCondition: false,
      exitCondition: false,
    };
  }

  if (!snapshot.dataFresh || !Number.isFinite(now)) {
    return { action: "none", next: state, symbol: state.activeSymbol, reason: "market data unavailable or stale", entryCondition: false, exitCondition: false };
  }

  if (state.state === "exit_pending") {
    return { action: "none", next: state, symbol: state.activeSymbol, reason: "exit already pending", entryCondition: false, exitCondition: true };
  }

  if (state.state === "cooldown") {
    const until = state.cooldownUntil ? new Date(state.cooldownUntil).getTime() : NaN;
    if (Number.isFinite(until) && now < until) {
      return { action: "none", next: state, symbol: null, reason: "cooldown active", entryCondition: false, exitCondition: false };
    }
    state.state = "off";
    state.cooldownUntil = null;
    state.entryStreak = 0;
  }

  const entryCondition =
    snapshot.dangerScore >= config.entryDangerScore &&
    snapshot.spyClose < snapshot.spySma50 &&
    (snapshot.spyReturn20Pct <= config.entryReturn20Pct ||
      snapshot.spyDrawdown20Pct <= config.entryDrawdown20Pct);

  const exitCondition =
    snapshot.dangerScore <= config.exitDangerScore &&
    snapshot.spyClose > snapshot.spySma50 &&
    snapshot.spyReturn5Pct >= 0;

  if (state.state === "active") {
    const heldMs = state.activeSince ? now - new Date(state.activeSince).getTime() : 0;
    const hardTimeExit = Number.isFinite(heldMs) && heldMs >= Math.max(1, config.maxHoldingDays) * 86_400_000;
    const exitStreak = hardTimeExit
      ? Math.max(1, config.exitConfirmations)
      : exitCondition ? clampCount(state.exitStreak + 1, config.exitConfirmations) : 0;

    if (exitStreak >= Math.max(1, config.exitConfirmations)) {
      return {
        action: "exit",
        next: { ...state, state: "exit_pending", exitStreak },
        symbol: state.activeSymbol,
        reason: hardTimeExit ? "maximum hedge holding period reached" : "risk-on exit confirmed",
        entryCondition,
        exitCondition: exitCondition || hardTimeExit,
      };
    }
    return {
      action: "none",
      next: { ...state, exitStreak },
      symbol: state.activeSymbol,
      reason: exitCondition ? `exit confirmation ${exitStreak}/${Math.max(1, config.exitConfirmations)}` : "hedge remains active",
      entryCondition,
      exitCondition,
    };
  }

  const symbol = chooseSymbol(config, snapshot);
  const entryStreak = entryCondition && symbol
    ? clampCount(state.entryStreak + 1, config.entryConfirmations)
    : 0;
  if (entryStreak >= Math.max(1, config.entryConfirmations) && symbol) {
    return {
      action: "enter",
      next: { state: "armed", entryStreak, exitStreak: 0, activeSymbol: symbol, activeSince: null, cooldownUntil: null },
      symbol,
      reason: `risk-off entry confirmed for ${symbol}`,
      entryCondition,
      exitCondition,
    };
  }
  return {
    action: "none",
    next: { ...state, state: entryStreak > 0 ? "armed" : "off", entryStreak, exitStreak: 0, activeSymbol: null, activeSince: null },
    symbol,
    reason: entryCondition && symbol ? `entry confirmation ${entryStreak}/${Math.max(1, config.entryConfirmations)}` : symbol ? "entry conditions not met" : "no permitted hedge instrument",
    entryCondition,
    exitCondition,
  };
}

export function cooldownState(nowIso: string, cooldownDays: number): HedgeState {
  return {
    state: "cooldown",
    entryStreak: 0,
    exitStreak: 0,
    activeSymbol: null,
    activeSince: null,
    cooldownUntil: addUtcDays(nowIso, cooldownDays),
  };
}
