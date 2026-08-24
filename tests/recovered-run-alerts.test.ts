import { describe, expect, it } from "vitest";
import { isTerminalSuccessfulRun, recoveredRunAlert } from "@/lib/monitoring/recovered-run-alerts";

const alert = { issue_key: "cron-stale:position_monitor:2026-08-18:us", created_at: "2026-08-18T23:00:00Z" };

describe("historical run alert recovery", () => {
  it("resolves only after the same market and job succeeds later", () => {
    expect(recoveredRunAlert(alert, [{ agent_type: "position_monitor", market: "us", status: "done", started_at: "2026-08-19T20:00:00Z" }])).toBe(true);
    expect(recoveredRunAlert(alert, [{ agent_type: "position_monitor", market: "india", status: "done", started_at: "2026-08-19T20:00:00Z" }])).toBe(false);
    expect(recoveredRunAlert(alert, [{ agent_type: "research", market: "us", status: "done", started_at: "2026-08-19T20:00:00Z" }])).toBe(false);
  });

  it("does not treat a later error or an earlier success as recovery", () => {
    expect(recoveredRunAlert(alert, [{ agent_type: "position_monitor", market: "us", status: "error", started_at: "2026-08-19T20:00:00Z" }])).toBe(false);
    expect(recoveredRunAlert(alert, [{ agent_type: "position_monitor", market: "us", status: "done", started_at: "2026-08-18T20:00:00Z" }])).toBe(false);
  });

  it("does not treat an in-flight or unknown status as recovery", () => {
    expect(recoveredRunAlert(alert, [{ agent_type: "position_monitor", market: "us", status: "running", started_at: "2026-08-19T20:00:00Z" }])).toBe(false);
    expect(recoveredRunAlert(alert, [{ agent_type: "position_monitor", market: "us", status: "queued", started_at: "2026-08-19T20:00:00Z" }])).toBe(false);
    expect(isTerminalSuccessfulRun("completed")).toBe(true);
    expect(isTerminalSuccessfulRun("running")).toBe(false);
  });

  it("supports the stable run-failed key and rejects unknown namespaces", () => {
    const run = [{ agent_type: "position_monitor", market: "us", status: "done", started_at: "2026-08-19T20:00:00Z" }];
    expect(recoveredRunAlert({ ...alert, issue_key: "run-failed:position_monitor:us" }, run)).toBe(true);
    expect(recoveredRunAlert({ ...alert, issue_key: "some-other-alert" }, run)).toBe(false);
  });
});
