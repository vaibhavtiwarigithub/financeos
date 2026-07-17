// Colour ramp for sector treemap cells.
//
// Extracted from SectorTreemap.tsx so the arithmetic is unit-testable without
// pulling React/recharts into the node test environment.
//
//   0% → #052E16 (near-black green) ... +3% → #34D399 (green)
//   0% → #3B0000 (near-black red)   ... −3% → #F87171 (red)
//
// Every channel must scale WITH intensity. The previous implementation applied
// (1 - intensity) to r/b on the positive branch and to g/b on the negative one,
// which walked the ramp backwards: cellColor(0) produced rgb(52,46,153) —
// indigo — and cellColor(-0.1) produced rgb(65,109,109) — teal, so a NEGATIVE
// sector rendered green. Neither legend swatch was reachable.

/** Moves at or beyond this magnitude (%) saturate the ramp. */
export const COLOR_CAP_PCT = 3;

export function cellColor(pct: number): string {
  const intensity = Math.min(Math.abs(pct), COLOR_CAP_PCT) / COLOR_CAP_PCT;
  const lerp = (from: number, to: number) => Math.round(from + (to - from) * intensity);
  if (pct >= 0) {
    // #052E16 → #34D399
    return `rgb(${lerp(5, 52)},${lerp(46, 211)},${lerp(22, 153)})`;
  }
  // #3B0000 → #F87171
  return `rgb(${lerp(59, 248)},${lerp(0, 113)},${lerp(0, 113)})`;
}
