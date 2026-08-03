import { describe, expect, it } from "vitest";
import { screenerDrySpellDays } from "@/lib/research-agent";

// The escalation rule behind `discovery-starved:us`. A ten-day US discovery
// outage went unnoticed because every component reported healthy while the
// funnel narrowed to names already held. These assert the rule that would have
// caught it.
describe("screenerDrySpellDays", () => {
  const row = (ts: string, discovery_source: string | null) => ({ ts, discovery_source });

  it("counts nothing when the most recent day had a screener candidate", () => {
    expect(screenerDrySpellDays([
      row("2026-08-02T14:00:00Z", "screener_momentum"),
      row("2026-08-01T14:00:00Z", "holding"),
    ])).toBe(0);
  });

  it("counts consecutive dry days back from the newest", () => {
    expect(screenerDrySpellDays([
      row("2026-08-02T14:00:00Z", "holding"),
      row("2026-08-01T14:00:00Z", "watchlist"),
      row("2026-07-31T14:00:00Z", "screener_value"),
    ])).toBe(2);
  });

  it("stops at the first day that had a screener candidate", () => {
    expect(screenerDrySpellDays([
      row("2026-08-02T09:00:00Z", "holding"),
      row("2026-08-01T09:00:00Z", "screener_momentum"),
      row("2026-07-31T09:00:00Z", "holding"),
      row("2026-07-30T09:00:00Z", "holding"),
    ])).toBe(1);
  });

  it("treats a day as covered if any decision that day came from the screener", () => {
    // Ordering within a day must not matter, and one screener row is enough.
    expect(screenerDrySpellDays([
      row("2026-08-02T09:00:00Z", "holding"),
      row("2026-08-02T10:00:00Z", "screener_value"),
      row("2026-08-02T11:00:00Z", "watchlist"),
    ])).toBe(0);
  });

  it("does not count days research never ran — a weekend must not escalate", () => {
    // Two research days, both dry. The calendar gap between them contributes
    // nothing, so the streak is 2 and not 4.
    expect(screenerDrySpellDays([
      row("2026-08-03T09:00:00Z", "holding"),
      row("2026-07-31T09:00:00Z", "holding"),
      row("2026-07-30T09:00:00Z", "screener_momentum"),
    ])).toBe(2);
  });

  it("reproduces the real outage: every source but the screener", () => {
    const rows = ["2026-08-02", "2026-08-01", "2026-07-31", "2026-07-30"].flatMap(d => [
      row(`${d}T09:00:00Z`, "holding"),
      row(`${d}T09:05:00Z`, "watchlist"),
      row(`${d}T09:10:00Z`, "manual"),
    ]);
    // 4 dry days observed; the run adding the 5th escalates well past the
    // 3-day critical threshold.
    expect(screenerDrySpellDays(rows)).toBe(4);
  });

  it("returns 0 for no observations rather than inventing a streak", () => {
    expect(screenerDrySpellDays([])).toBe(0);
  });
});
