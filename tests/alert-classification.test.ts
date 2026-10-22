import { describe, expect, it } from "vitest";
import { isActionableHealthAlert, isInformationalNoticeAlert, isOwnerActionAlert } from "@/lib/alerts/classification";

describe("shared alert classification", () => {
  it("keeps broker reconnect and owner actions out of the failure count", () => {
    expect(isOwnerActionAlert({ category: "broker", severity: "critical", title: "Reconnect required" })).toBe(true);
    expect(isOwnerActionAlert({ category: "cron", title: "Reconnect required" })).toBe(true);
    expect(isOwnerActionAlert({ category: "cron", detail: "Claude and Codex members run on your PC; the local machine may be off or asleep." })).toBe(true);
    expect(isActionableHealthAlert({ category: "broker", severity: "critical", title: "Reconnect required" })).toBe(false);
  });

  it("does not hide broker faults behind their category or suggested reconnect", () => {
    for (const title of ["Broker position mismatch detected", "Protective order cancel failed", "Broker order submission failed", "Unknown broker failure"]) {
      expect(isActionableHealthAlert({ category: "broker", severity: "critical", title })).toBe(true);
    }
    expect(isActionableHealthAlert({ category: "broker", severity: "critical", title: "Position mismatch", detail: "Reconnect and reconcile before retrying" })).toBe(true);
    expect(isActionableHealthAlert({ severity: "critical", title: "✅ Evidence is ready but ledger mismatch detected" })).toBe(true);
  });

  it("counts warnings and critical failures but not informational notices", () => {
    expect(isActionableHealthAlert({ severity: "warn", category: "data" })).toBe(true);
    expect(isActionableHealthAlert({ severity: "critical", category: "cron" })).toBe(true);
    expect(isActionableHealthAlert({ severity: "info", category: "data" })).toBe(false);
    expect(isActionableHealthAlert({ severity: "success", category: "system" })).toBe(false);
    expect(isInformationalNoticeAlert({ severity: "warn", title: "✅ Router shadow evidence is ready" })).toBe(true);
    expect(isActionableHealthAlert({ severity: "warn", title: "✅ Router shadow evidence is ready" })).toBe(false);
  });
});
