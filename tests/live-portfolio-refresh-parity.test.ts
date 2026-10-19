import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

describe("live portfolio refresh and market boundaries", () => {
  const refresh = read("app/api/live-account/refresh-snapshot/route.ts");
  const usPage = read("components/dashboard/LivePortfolioPage.tsx");
  const indiaPage = read("components/dashboard/IndiaLivePanel.tsx");
  const kitePortfolio = read("app/api/kite/portfolio/route.ts");

  it("keeps the cron secret path and adds owner-authenticated JSON-only manual refresh", () => {
    expect(refresh).toContain("if (!verifyCronSecret(req))");
    expect(refresh).toContain('includes("application/json")');
    expect(refresh).toContain("const ownerGate = await requireOwner()");
    expect(refresh).toContain("const registry = await refreshRegistryBrokers()");
    expect(refresh).toContain("const alpacaLive = await refreshAlpacaLive()");
    expect(refresh).toContain("const kite = await refreshKite()");
    expect(refresh).not.toMatch(/kitePost\(|kitePut\(|placeOrder\(/);
  });

  it("shows a real sync action and distinguishes it from reloading saved data", () => {
    expect(usPage).toContain('fetch("/api/live-account/refresh-snapshot"');
    expect(usPage).toContain("Sync brokers");
    expect(usPage).toContain("last successful snapshots are preserved");
    expect(indiaPage).toContain('fetch("/api/live-account/refresh-snapshot"');
    expect(indiaPage).toContain("Sync brokers");
  });

  it("keeps Kite day positions separate and out of combined holdings/NAV", () => {
    expect(kitePortfolio).toContain("getKitePositions()");
    expect(kitePortfolio).toContain("positions_available: positionsRes.ok");
    expect(kitePortfolio).toContain("positions,");
    expect(kitePortfolio).toContain("const nav = cash != null ? cash + holdingsValue : null");
    expect(indiaPage).toContain("not added to delivery holdings or NAV");
  });

  it("routes refresh failures through the existing broker health issue lifecycle", () => {
    expect(refresh).toContain('issueKey: `broker-snapshot:${cfg.id}`');
    expect(refresh).toContain('issueKey: "broker-snapshot:kite"');
    expect(refresh).toContain('await resolveIssue(`broker-snapshot:${cfg.id}`)');
    expect(refresh).toContain('await resolveIssue("broker-snapshot:kite", svc)');
  });
});
