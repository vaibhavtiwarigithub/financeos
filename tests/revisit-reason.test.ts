import { describe, it, expect } from "vitest";
import { computeRevisitReason } from "@/lib/revisit-reason";

const NOW = new Date("2026-07-15T12:00:00Z");
const inDays = (n: number) => new Date(NOW.getTime() + n * 86400000).toISOString().slice(0, 10);
const tsAgo = (n: number) => new Date(NOW.getTime() - n * 86400000).toISOString();

describe("computeRevisitReason", () => {
  it("flags imminent earnings as high urgency (<=3 days)", () => {
    const r = computeRevisitReason({ nextEarningsDate: inDays(2), now: NOW });
    expect(r.urgency).toBe("high");
    expect(r.reason).toMatch(/Earnings in 2 days/);
  });

  it("says 'today'/'tomorrow' for 0/1 day earnings", () => {
    expect(computeRevisitReason({ nextEarningsDate: inDays(0), now: NOW }).reason).toMatch(/Earnings today/);
    expect(computeRevisitReason({ nextEarningsDate: inDays(1), now: NOW }).reason).toMatch(/Earnings tomorrow/);
  });

  it("earnings 4-14 days out is medium urgency", () => {
    const r = computeRevisitReason({ nextEarningsDate: inDays(10), now: NOW });
    expect(r.urgency).toBe("medium");
    expect(r.reason).toMatch(/in 10 days/);
  });

  it("notes the earnings alert flag when set", () => {
    const r = computeRevisitReason({ nextEarningsDate: inDays(2), alertOnEarnings: true, now: NOW });
    expect(r.reason).toMatch(/earnings alert on/);
  });

  it("ignores earnings more than 14 days out", () => {
    const r = computeRevisitReason({ nextEarningsDate: inDays(30), now: NOW });
    expect(r.reason).not.toMatch(/Earnings/);
    expect(r.urgency).toBe("none");
  });

  it("earnings takes precedence over a deferred re-queue", () => {
    const r = computeRevisitReason({ nextEarningsDate: inDays(1), deferredAt: tsAgo(2), now: NOW });
    expect(r.reason).toMatch(/Earnings tomorrow/);
  });

  it("flags a watchlist row expiring soon", () => {
    // NOW is 12:00Z; +1 day at 12:00Z rounds to 2 days from UTC midnight.
    const r = computeRevisitReason({ expiresAt: new Date(NOW.getTime() + 1 * 86400000).toISOString(), now: NOW });
    expect(r.reason).toMatch(/Watchlist entry expires in 2 days — keep or drop/);
    expect(r.urgency).toBe("medium");
  });

  it("flags a re-queued (deferred) symbol with an age", () => {
    const r = computeRevisitReason({ deferredAt: tsAgo(3), now: NOW });
    expect(r.reason).toMatch(/Re-queued \(deferred 3d ago\)/);
    expect(r.urgency).toBe("medium");
  });

  it("flags a stale score past the threshold", () => {
    const r = computeRevisitReason({ scoreAgeDays: 12, staleAfterDays: 7, now: NOW });
    expect(r.reason).toMatch(/Score stale \(>7d, last 12d ago\)/);
    expect(r.urgency).toBe("low");
  });

  it("does not flag a fresh score", () => {
    const r = computeRevisitReason({ scoreAgeDays: 3, staleAfterDays: 7, now: NOW });
    expect(r.urgency).toBe("none");
  });

  it("surfaces queue priority when nothing more urgent applies", () => {
    const r = computeRevisitReason({ priority: 5, attempts: 2, now: NOW });
    expect(r.reason).toMatch(/Queued \(priority 5 · 2 attempts\)/);
    expect(r.urgency).toBe("low");
  });

  it("returns none when there's nothing to say", () => {
    const r = computeRevisitReason({ now: NOW });
    expect(r).toEqual({ reason: "", urgency: "none" });
  });
});
