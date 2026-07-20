import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("app/api/settings/kill-switch/route.ts", "utf8");

describe("guarded kill-switch reset contract", () => {
  it("is owner-only and requires explicit acknowledgement", () => {
    expect(source.match(/await requireOwner\(\)/g)?.length).toBe(2);
    expect(source).toContain("body.acknowledged !== true");
  });

  it("rechecks the originating book without clearing alerts early", () => {
    expect(source).toContain("trippedBook !== book");
    expect(source).toContain("resolveAlerts: false");
    expect(source).toContain("if (!check.safe)");
  });

  it("audits before enabling and resolves only matching kill alerts", () => {
    const auditAt = source.indexOf('.from("decision_journal").insert');
    const enableAt = source.indexOf("setMarketTrading(svc, market, true)");
    expect(auditAt).toBeGreaterThan(0);
    expect(enableAt).toBeGreaterThan(auditAt);
    expect(source).toContain("`killswitch:${market}:${book}`");
    expect(source).not.toContain("killswitch-orders:${market}");
  });
});
