import { describe, expect, it } from "vitest";
import { admitMarketLocalSlot } from "@/lib/trading/market-calendar";

describe("admitMarketLocalSlot", () => {
  it("keeps 09:00 New York stable across EDT and EST", () => {
    expect(admitMarketLocalSlot("us", "09:00", new Date("2026-07-31T13:00:00Z")).admitted).toBe(true);
    expect(admitMarketLocalSlot("us", "09:00", new Date("2026-07-31T14:00:00Z")).admitted).toBe(false);
    expect(admitMarketLocalSlot("us", "09:00", new Date("2026-12-01T14:00:00Z")).admitted).toBe(true);
    expect(admitMarketLocalSlot("us", "09:00", new Date("2026-12-01T13:00:00Z")).admitted).toBe(false);
  });

  it("keeps India fixed and rejects malformed slots", () => {
    expect(admitMarketLocalSlot("india", "09:30", new Date("2026-07-31T04:00:00Z")).admitted).toBe(true);
    expect(admitMarketLocalSlot("india", "9:30", new Date("2026-07-31T04:00:00Z"))).toMatchObject({
      admitted: false,
      reason: "invalid_slot",
    });
  });
});
