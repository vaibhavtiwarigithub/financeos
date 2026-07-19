import { describe, it, expect } from "vitest";
import { isMarketSessionOpen, isMarketHoliday, isMarketWeekend, lastCompletedMarketSession } from "@/lib/trading/market-calendar";

// Fixed UTC instants → market-local via IANA tz. July = EDT (UTC-4), IST = UTC+5:30.
describe("market-calendar: isMarketSessionOpen", () => {
  it("US: open mid-session on a normal weekday (Thu 11:00 ET)", () => {
    expect(isMarketSessionOpen("us", new Date("2026-07-09T15:00:00Z"))).toBe(true);
  });
  it("US: closed after 16:00 ET", () => {
    expect(isMarketSessionOpen("us", new Date("2026-07-09T21:00:00Z"))).toBe(false); // 17:00 ET
  });
  it("US: closed before 09:30 ET", () => {
    expect(isMarketSessionOpen("us", new Date("2026-07-09T12:00:00Z"))).toBe(false); // 08:00 ET
  });
  it("US: closed on a weekend even during hours", () => {
    expect(isMarketSessionOpen("us", new Date("2026-07-11T15:00:00Z"))).toBe(false); // Saturday
  });
  it("US: closed on a weekday HOLIDAY during hours (Jul 3 observed)", () => {
    expect(isMarketSessionOpen("us", new Date("2026-07-03T15:00:00Z"))).toBe(false);
  });
  it("India: open mid-session (Thu 11:30 IST)", () => {
    expect(isMarketSessionOpen("india", new Date("2026-07-09T06:00:00Z"))).toBe(true);
  });
  it("India: closed after 15:30 IST", () => {
    expect(isMarketSessionOpen("india", new Date("2026-07-09T11:00:00Z"))).toBe(false); // 16:30 IST
  });
  it("India: closed on Independence Day (weekday holiday)", () => {
    // 2026-08-15 is a Saturday, but the holiday list must still short-circuit;
    // use Republic Day 2026-01-26 (Monday) during IST hours instead.
    expect(isMarketSessionOpen("india", new Date("2026-01-26T06:00:00Z"))).toBe(false);
  });
});

describe("market-calendar: isMarketHoliday", () => {
  it("flags US NYSE holidays", () => {
    expect(isMarketHoliday("us", "2026-07-03")).toBe(true);
    expect(isMarketHoliday("us", "2026-12-25")).toBe(true);
    expect(isMarketHoliday("us", "2026-07-09")).toBe(false);
  });
  it("flags India NSE holidays independently of US", () => {
    expect(isMarketHoliday("india", "2026-01-26")).toBe(true);
    expect(isMarketHoliday("india", "2026-07-03")).toBe(false); // US-only holiday
  });
});

describe("market-calendar: weekend research sessions", () => {
  it("uses Friday for both Saturday and Sunday catch-up", () => {
    expect(lastCompletedMarketSession("us", new Date("2026-07-18T15:00:00Z"))).toBe("2026-07-17");
    expect(lastCompletedMarketSession("us", new Date("2026-07-19T15:00:00Z"))).toBe("2026-07-17");
    expect(lastCompletedMarketSession("india", new Date("2026-07-19T05:00:00Z"))).toBe("2026-07-17");
  });

  it("skips a Friday holiday when labeling the completed session", () => {
    expect(lastCompletedMarketSession("us", new Date("2026-07-04T15:00:00Z"))).toBe("2026-07-02");
  });

  it("evaluates weekends in each market's local timezone", () => {
    expect(isMarketWeekend("us", new Date("2026-07-18T03:30:00Z"))).toBe(false); // Fri 23:30 ET
    expect(isMarketWeekend("india", new Date("2026-07-18T03:30:00Z"))).toBe(true); // Sat 09:00 IST
  });
});
