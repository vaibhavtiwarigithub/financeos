import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { admitMarketLocalSlot } from "@/lib/trading/market-calendar";

describe("dedicated leveraged research before paper doors", () => {
  it("selects exactly one 10:30 ET wake across daylight saving changes", () => {
    expect(admitMarketLocalSlot("us", "10:30", new Date("2026-10-16T14:30:00Z")).admitted).toBe(true);
    expect(admitMarketLocalSlot("us", "10:30", new Date("2026-10-16T15:30:00Z")).admitted).toBe(false);
    expect(admitMarketLocalSlot("us", "10:30", new Date("2026-12-16T14:30:00Z")).admitted).toBe(false);
    expect(admitMarketLocalSlot("us", "10:30", new Date("2026-12-16T15:30:00Z")).admitted).toBe(true);
  });
  it("has its own run identity and only the approved leveraged sleeve symbols", () => {
    const route = readFileSync("app/api/agents/research/cron/route.ts", "utf8");
    expect(route).toContain('runAgentType = leveragedOnly ? "research_leveraged"');
    expect(route).toContain('gatherSymbols(supabase, [...LEVERAGED_SLEEVE_SYMBOLS], "us")');
    const migration = readFileSync("supabase/migrations/20261017003000_leveraged_research_pre_entry.sql", "utf8");
    expect(migration).toContain("'30 14,15 * * 1-5'");
    expect(migration).toContain("scope=leveraged&local_slot=10%3A30");
  });
});
