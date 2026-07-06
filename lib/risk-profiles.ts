// Single source of truth for the 3 risk-profile dial sets. Was previously
// hand-duplicated in 3 places (app/api/settings/risk-profile/route.ts's
// PROFILES, app/api/agents/research/cron/route.ts's PROFILE_DIALS for
// posture auto-revert, and lib/kill-switches.ts's hardcoded fallback
// defaults) — three independent copies of the same numbers that could
// silently drift out of sync. Import RISK_PROFILES from here everywhere.

export interface RiskProfileDials {
  score_threshold: number;
  position_size_pct: number;
  stop_loss_pct: number;
  target_pct: number;
  max_positions_per_sector: number;
  ks_daily_loss_pct: number;
  ks_drawdown_pct: number;
  ks_accuracy_pct: number;
  exit_hysteresis: number;
}

export const RISK_PROFILES: Record<"conservative" | "balanced" | "aggressive", RiskProfileDials> = {
  conservative: { score_threshold: 72, position_size_pct: 7, stop_loss_pct: 5, target_pct: 12, max_positions_per_sector: 2, ks_daily_loss_pct: -4, ks_drawdown_pct: 15, ks_accuracy_pct: 45, exit_hysteresis: 10 },
  balanced:     { score_threshold: 60, position_size_pct: 10, stop_loss_pct: 7, target_pct: 20, max_positions_per_sector: 3, ks_daily_loss_pct: -5, ks_drawdown_pct: 20, ks_accuracy_pct: 40, exit_hysteresis: 15 },
  aggressive:   { score_threshold: 52, position_size_pct: 15, stop_loss_pct: 10, target_pct: 35, max_positions_per_sector: 4, ks_daily_loss_pct: -7, ks_drawdown_pct: 25, ks_accuracy_pct: 35, exit_hysteresis: 20 },
};

// The "balanced" profile's kill-switch dials, used as kill-switches.ts's
// fallback when strategy_config's own ks_* columns are null/missing — kept
// here instead of a fourth hardcoded copy.
export const DEFAULT_KILL_SWITCH_DIALS = {
  ks_daily_loss_pct: RISK_PROFILES.balanced.ks_daily_loss_pct,
  ks_drawdown_pct: RISK_PROFILES.balanced.ks_drawdown_pct,
  ks_accuracy_pct: RISK_PROFILES.balanced.ks_accuracy_pct,
};
