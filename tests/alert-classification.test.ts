import { describe, expect, it } from "vitest";
import { isActionableHealthAlert, isInformationalNoticeAlert, isOwnerActionAlert } from "@/lib/alerts/classification";

describe("shared alert classification", () => {
  it("keeps broker reconnect and owner actions out of the failure count", () => {
    expect(isOwnerActionAlert({ category: "broker", severity: "critical" })).toBe(true);
    expect(isOwnerActionAlert({ category: "cron", title: "Reconnect required" })).toBe(true);
    expect(isOwnerActionAlert({ category: "cron", detail: "Claude and Codex members run on your PC; the local machine may be off or asleep." })).toBe(true);
    expect(isActionableHealthAlert({ category: "broker", severity: "critical" })).toBe(false);
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
