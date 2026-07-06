// Win/loss/breakeven classification — was previously a fixed absolute-dollar
// band (+/-$0.5) at every call site, which is meaningless for India (₹)
// positions where ₹0.5 is noise-level and skews win-rate stats (which feed
// directly into lib/kill-switches.ts's 30-day accuracy kill switch). Use a
// relative (%) band instead — works the same regardless of currency or
// position size.
const BREAKEVEN_BAND_PCT = 0.1; // +/-0.1% treated as breakeven, not noise-driven win/loss

export function classifyOutcome(pnlPct: number): "win" | "loss" | "breakeven" {
  if (pnlPct > BREAKEVEN_BAND_PCT) return "win";
  if (pnlPct < -BREAKEVEN_BAND_PCT) return "loss";
  return "breakeven";
}
