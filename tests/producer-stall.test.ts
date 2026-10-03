import { describe, expect, it } from "vitest";
import { detectStalledProducers, type ProducerRunRow } from "@/lib/monitoring/producer-stall";

const run = (program: string, status: string, startedAt: string, blocker?: string): ProducerRunRow =>
  ({ program_id: program, market: "us", status, started_at: startedAt, blockers: blocker ? [blocker] : [] });

describe("detectStalledProducers (ATR forward book was blocked/errored 2026-09-28..10-03 with no alert)", () => {
  it("flags a producer whose last 4 runs span two days and none collected, with the latest blocker", () => {
    const rows = [
      run("exit-stop-shadow", "error", "2026-10-02T23:45:01Z", "Snapshot removed decisions"),
      run("exit-stop-shadow", "error", "2026-10-02T22:15:02Z"),
      run("exit-stop-shadow", "blocked", "2026-10-01T23:45:01Z"),
      run("exit-stop-shadow", "blocked", "2026-10-01T22:15:02Z"),
      run("exit-stop-shadow", "collected", "2026-09-28T13:07:12Z"),
    ];
    const stalled = detectStalledProducers(rows);
    expect(stalled).toHaveLength(1);
    expect(stalled[0]).toMatchObject({ programId: "exit-stop-shadow", runs: 4, lastStatus: "error", lastBlocker: "Snapshot removed decisions" });
  });
  it("does not flag a healthy producer, a recovering one, or too little history", () => {
    expect(detectStalledProducers([
      run("p", "collected", "2026-10-02T23:45:00Z"), run("p", "error", "2026-10-02T22:15:00Z"),
      run("p", "error", "2026-10-01T23:45:00Z"), run("p", "error", "2026-10-01T22:15:00Z"),
    ])).toEqual([]);
    expect(detectStalledProducers([run("p", "error", "2026-10-02T23:45:00Z"), run("p", "error", "2026-10-02T22:15:00Z")])).toEqual([]);
  });
  it("needs two distinct UTC days (a single bad evening with retries is not a stall) and keeps programs/markets separate", () => {
    const sameDay = ["22:15", "22:45", "23:15", "23:45"].map((t) => run("p", "blocked", `2026-10-02T${t}:00Z`));
    expect(detectStalledProducers(sameDay)).toEqual([]);
    const mixed = [...[1, 2].flatMap((d) => ["22:15", "23:45"].map((t) => run("a", "blocked", `2026-10-0${d}T${t}:00Z`))),
      run("b", "collected", "2026-10-02T23:00:00Z")];
    expect(detectStalledProducers(mixed).map((row) => row.programId)).toEqual(["a"]);
  });
});
