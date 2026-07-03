export interface StrategyConditions {
  technical?: {
    rsi_min?: number; rsi_max?: number;
    price_above_ma50?: boolean; price_above_ma200?: boolean;
    volume_surge?: boolean; macd_cross_up?: boolean;
  };
  fundamental?: {
    revenue_growth_min?: number; pe_max?: number; pe_min?: number;
    fcf_yield_min?: number; debt_equity_max?: number;
    roe_min?: number; gross_margin_min?: number;
  };
}

export interface AlgoStrategy {
  id: string;
  name: string;
  icon: string;
  tagline: string;
  description: string;
  regimes: string[];
  conditions: StrategyConditions;
  backtest_defaults: {
    score_threshold: number; target_pct: number;
    stop_loss_pct: number; max_hold_days: number;
  };
  scan_filters: Array<{ field: string; operator: "gt" | "lt" | "gte" | "lte" | "eq"; value: number }>;
  typical: { win_rate_low: number; win_rate_high: number; sharpe_low: number; sharpe_high: number; avg_hold_days: number };
  best_when: string[];
  failure_modes: string[];
  edge_explanation: string;
  position_sizing: string;
  kelly_note: string;
}

export const ALGO_STRATEGIES: AlgoStrategy[] = [
  {
    id: "momentum",
    name: "Momentum",
    icon: "⚡",
    tagline: "Ride strength — buy what's already winning",
    description: "Buys stocks with accelerating price momentum and fundamental validation. Requires RSI > 60 confirming trend, price above 50-day MA, and revenue acceleration showing the fundamental thesis is real.",
    regimes: ["BULL", "LOW_VIX", "TRENDING"],
    conditions: {
      technical: { rsi_min: 60, price_above_ma50: true },
      fundamental: { revenue_growth_min: 0.10, gross_margin_min: 0.25 },
    },
    backtest_defaults: { score_threshold: 60, target_pct: 20, stop_loss_pct: 7, max_hold_days: 15 },
    scan_filters: [
      { field: "revenue_growth", operator: "gt", value: 0.10 },
      { field: "gross_margin", operator: "gt", value: 0.25 },
      { field: "return_on_equity", operator: "gt", value: 0.15 },
      { field: "market_cap", operator: "gt", value: 2000000000 },
    ],
    typical: { win_rate_low: 52, win_rate_high: 65, sharpe_low: 0.6, sharpe_high: 1.4, avg_hold_days: 8 },
    best_when: ["S&P 500 above 200MA", "VIX < 20", "Rate environment stable", "Earnings season with beats"],
    failure_modes: ["Choppy/sideways markets", "Crowded exits when trend breaks", "High VIX reversals", "Bear markets — momentum magnifies losses"],
    edge_explanation: "Market underreacts to earnings acceleration. Momentum persists 3–12 months (Jegadeesh & Titman 1993). RSI > 60 filters out mean-reversion noise.",
    position_sizing: "Full Kelly at 10% NAV per position — high win rate supports larger size",
    kelly_note: "Typical Kelly fraction: 0.15–0.25. Use half-Kelly (0.08–0.12) to reduce variance.",
  },
  {
    id: "mean_reversion",
    name: "Mean Reversion",
    icon: "↩",
    tagline: "Buy oversold quality — market overreacted",
    description: "Buys fundamentally sound companies when price has fallen sharply and RSI is oversold (< 35). Bet that the market overreacted to short-term news and price reverts to fair value.",
    regimes: ["SIDEWAYS", "RANGE_BOUND", "HIGH_VIX"],
    conditions: {
      technical: { rsi_max: 35 },
      fundamental: { pe_max: 25, roe_min: 0.12, debt_equity_max: 1.0 },
    },
    backtest_defaults: { score_threshold: 55, target_pct: 12, stop_loss_pct: 8, max_hold_days: 10 },
    scan_filters: [
      { field: "pe_ratio", operator: "gt", value: 1 },
      { field: "pe_ratio", operator: "lt", value: 25 },
      { field: "return_on_equity", operator: "gt", value: 0.12 },
      { field: "debt_to_equity", operator: "lt", value: 1.0 },
      { field: "market_cap", operator: "gt", value: 1000000000 },
    ],
    typical: { win_rate_low: 55, win_rate_high: 68, sharpe_low: 0.7, sharpe_high: 1.3, avg_hold_days: 6 },
    best_when: ["VIX > 20", "Sideways range-bound market", "Post-earnings overreaction", "Sector rotation selling quality indiscriminately"],
    failure_modes: ["Fundamental deterioration masked as short-term noise", "Catching falling knives in downtrends", "Works poorly in sustained bear markets"],
    edge_explanation: "Behavioral finance: investors overreact to negative surprises. De Bondt & Thaler (1985) showed 3–5 year reversal. Short-term: sentiment washout creates entry.",
    position_sizing: "Smaller size (7% NAV) — uncertainty higher on oversold names",
    kelly_note: "Typical Kelly: 0.18–0.30 due to high win rate, but use 0.07–0.10 size limit given tail risk.",
  },
  {
    id: "garp",
    name: "GARP",
    icon: "⬡",
    tagline: "Growth at a Reasonable Price",
    description: "Lynch-style: find companies growing 15–25% annually but not priced for perfection (PEG < 1.5). Sweet spot between pure value (too slow) and pure growth (overvalued).",
    regimes: ["BULL", "NEUTRAL", "RATE_STABLE"],
    conditions: {
      fundamental: { revenue_growth_min: 0.15, pe_max: 30, fcf_yield_min: 0.02 },
    },
    backtest_defaults: { score_threshold: 62, target_pct: 18, stop_loss_pct: 8, max_hold_days: 20 },
    scan_filters: [
      { field: "revenue_growth", operator: "gt", value: 0.15 },
      { field: "earnings_growth", operator: "gt", value: 0.12 },
      { field: "pe_ratio", operator: "lt", value: 30 },
      { field: "free_cash_flow_yield", operator: "gt", value: 0.02 },
      { field: "market_cap", operator: "gt", value: 500000000 },
    ],
    typical: { win_rate_low: 50, win_rate_high: 62, sharpe_low: 0.5, sharpe_high: 1.0, avg_hold_days: 14 },
    best_when: ["Moderate growth environment", "When growth stocks have been de-rated", "Mid/large cap sweet spot"],
    failure_modes: ["Rate hikes compress multiples even on growing companies", "Requires patience — takes longer to play out"],
    edge_explanation: "PEG ratio (P/E ÷ growth) < 1.5 identifies mispriced growth. Market often pays too much for high-flyers and ignores solid GARP names.",
    position_sizing: "10% NAV standard",
    kelly_note: "Moderate Kelly: 0.10–0.18. Longer hold = more uncertainty.",
  },
  {
    id: "value",
    name: "Deep Value",
    icon: "◈",
    tagline: "Buy cheap — wait for rerating",
    description: "Graham/Buffett style: low P/E, high FCF yield, insider buying, strong balance sheet. Requires patience but has best long-run alpha evidence. NOT for short swing trades.",
    regimes: ["BEAR", "LATE_CYCLE", "RATE_HIGH"],
    conditions: {
      fundamental: { pe_max: 15, fcf_yield_min: 0.05, debt_equity_max: 0.5 },
    },
    backtest_defaults: { score_threshold: 58, target_pct: 25, stop_loss_pct: 10, max_hold_days: 30 },
    scan_filters: [
      { field: "pe_ratio", operator: "gt", value: 1 },
      { field: "pe_ratio", operator: "lt", value: 15 },
      { field: "free_cash_flow_yield", operator: "gt", value: 0.05 },
      { field: "debt_to_equity", operator: "lt", value: 0.5 },
      { field: "market_cap", operator: "gt", value: 500000000 },
    ],
    typical: { win_rate_low: 45, win_rate_high: 58, sharpe_low: 0.4, sharpe_high: 0.9, avg_hold_days: 25 },
    best_when: ["High rate environment (cash flow matters)", "Late business cycle", "Post-crash recovery phases", "Sector beaten down on sentiment not fundamentals"],
    failure_modes: ["Value traps: cheap for a reason", "Can stay cheap for years", "Underperforms in growth/momentum rallies"],
    edge_explanation: "Fama-French value premium: 4.8%/year over 90 years. Behavioral: investors extrapolate bad news too far. Insider buying = alignment signal.",
    position_sizing: "Longer hold — size 8% NAV, allow more time",
    kelly_note: "Lower Kelly (0.08–0.15) — longer time horizon, lower confidence per trade.",
  },
  {
    id: "breakout",
    name: "Breakout",
    icon: "▲",
    tagline: "Buy the breakout from consolidation",
    description: "Buys stocks breaking above key resistance levels with volume confirmation. Works on the principle that consolidation is energy storage — breakout releases it.",
    regimes: ["BULL", "TRENDING", "LOW_VIX"],
    conditions: {
      technical: { price_above_ma50: true, volume_surge: true },
      fundamental: { revenue_growth_min: 0.05 },
    },
    backtest_defaults: { score_threshold: 65, target_pct: 15, stop_loss_pct: 5, max_hold_days: 10 },
    scan_filters: [
      { field: "revenue_growth", operator: "gt", value: 0.05 },
      { field: "market_cap", operator: "gt", value: 1000000000 },
      { field: "return_on_equity", operator: "gt", value: 0.10 },
    ],
    typical: { win_rate_low: 45, win_rate_high: 58, sharpe_low: 0.5, sharpe_high: 1.1, avg_hold_days: 7 },
    best_when: ["Low VIX", "Post-consolidation on strong fundamentals", "Sector rotation into the stock's sector"],
    failure_modes: ["Fakeouts — price breaks then retreats (common in high VIX)", "Stop must be tight — breakouts that fail, fail fast"],
    edge_explanation: "Supply/demand: breakout above resistance clears sellers. New buyers not anchored to old price = fast upside. Volume confirms institutional participation.",
    position_sizing: "Smaller size (7%), tight stop — binary outcome",
    kelly_note: "Kelly 0.08–0.15 due to lower win rate. Edge is in sizing correctly on the winners.",
  },
  {
    id: "earnings_drift",
    name: "Earnings Drift (PEAD)",
    icon: "▦",
    tagline: "Buy earnings beats — drift continues for weeks",
    description: "Post-Earnings Announcement Drift: price continues in the direction of earnings surprise for 2–6 weeks. Buy stocks that beat EPS estimates by > 5% on strong revenue.",
    regimes: ["ALL", "EARNINGS_SEASON"],
    conditions: {
      fundamental: { revenue_growth_min: 0.08 },
    },
    backtest_defaults: { score_threshold: 58, target_pct: 12, stop_loss_pct: 6, max_hold_days: 15 },
    scan_filters: [
      { field: "earnings_growth", operator: "gt", value: 0.10 },
      { field: "revenue_growth", operator: "gt", value: 0.08 },
      { field: "market_cap", operator: "gt", value: 2000000000 },
    ],
    typical: { win_rate_low: 55, win_rate_high: 70, sharpe_low: 0.7, sharpe_high: 1.5, avg_hold_days: 10 },
    best_when: ["Just after earnings beat", "Analyst revision season", "Large cap with high institutional ownership"],
    failure_modes: ["Buy the news, sell the fact — can reverse", "Already priced in: stock up 10% on earnings may not drift more"],
    edge_explanation: "Bernard & Thomas (1989): PEAD generates 4–6% excess return over 60 days. Behavioral lag: analysts slow to revise estimates after earnings surprise.",
    position_sizing: "Buy within 2 days of earnings beat, hold 1–3 weeks. 10% NAV.",
    kelly_note: "Highest Kelly justification (0.20–0.35) of any strategy — strong empirical evidence. Use 10% NAV hard cap anyway.",
  },
  {
    id: "rsi_bounce",
    name: "RSI Oversold Bounce",
    icon: "◎",
    tagline: "Technical bounce from oversold extreme",
    description: "Pure technical play: buy when RSI < 30 on quality stocks with no fundamental deterioration. Fastest strategy — holds 2–5 days. High win rate but small individual gains.",
    regimes: ["ALL", "HIGH_VIX"],
    conditions: {
      technical: { rsi_max: 30 },
      fundamental: { roe_min: 0.10, debt_equity_max: 2.0 },
    },
    backtest_defaults: { score_threshold: 50, target_pct: 8, stop_loss_pct: 4, max_hold_days: 5 },
    scan_filters: [
      { field: "return_on_equity", operator: "gt", value: 0.10 },
      { field: "debt_to_equity", operator: "lt", value: 2.0 },
      { field: "market_cap", operator: "gt", value: 2000000000 },
    ],
    typical: { win_rate_low: 60, win_rate_high: 72, sharpe_low: 0.8, sharpe_high: 1.6, avg_hold_days: 4 },
    best_when: ["Market-wide selloff creating indiscriminate oversold", "VIX spike > 25", "Strong underlying fundamental but news-driven dip"],
    failure_modes: ["Broken stocks in downtrends — RSI < 30 is norm not anomaly", "Works less in sustained bear markets"],
    edge_explanation: "Short-term mean reversion: overselling creates imbalance. Market makers buy to provide liquidity. Usually snaps back within 1 week.",
    position_sizing: "Small size (6%), tight stop. High frequency small wins.",
    kelly_note: "High Kelly justified by win rate but small edge size. Keep 6% NAV max.",
  },
  {
    id: "macd_crossover",
    name: "MACD Crossover",
    icon: "⟋",
    tagline: "Follow the signal line crossover",
    description: "Classic MACD(12,26,9): buy when MACD line crosses above signal line with positive histogram. Used alone it's mediocre — must be combined with fundamental filter and regime check.",
    regimes: ["BULL", "TRENDING"],
    conditions: {
      technical: { macd_cross_up: true, price_above_ma50: true },
      fundamental: { revenue_growth_min: 0.05 },
    },
    backtest_defaults: { score_threshold: 58, target_pct: 15, stop_loss_pct: 7, max_hold_days: 12 },
    scan_filters: [
      { field: "revenue_growth", operator: "gt", value: 0.05 },
      { field: "market_cap", operator: "gt", value: 1000000000 },
      { field: "profit_margin", operator: "gt", value: 0.05 },
    ],
    typical: { win_rate_low: 45, win_rate_high: 55, sharpe_low: 0.3, sharpe_high: 0.8, avg_hold_days: 10 },
    best_when: ["Trending market, not choppy", "Combined with volume confirmation", "After confirmed regime is bullish"],
    failure_modes: ["Lagging indicator — many false signals in chop", "Used alone: Sharpe typically < 0.5", "Must combine with fundamental filter to be useful"],
    edge_explanation: "Modest empirical support. Best used as signal confirmation, not primary signal. Works best when macro regime is clearly bullish.",
    position_sizing: "10% NAV standard",
    kelly_note: "Low standalone Kelly. Only take MACD signals when other conditions also align.",
  },
];

export const STRATEGY_MAP = Object.fromEntries(ALGO_STRATEGIES.map(s => [s.id, s]));
