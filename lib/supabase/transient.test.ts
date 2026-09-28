import { describe, expect, it, vi } from "vitest";
import { withSupabaseRetry } from "./transient";

type TestResult = { data: Array<{ id: number }> | null; error: { message: string } | null };

describe("withSupabaseRetry", () => {
  it("retries a transient read error and returns the successful result", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { message: "Gateway Timeout" } })
      .mockResolvedValueOnce({ data: [{ id: 1 }], error: null });
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await withSupabaseRetry<TestResult>(run, { retries: 2, delayMs: 400, sleep });

    expect(result.data).toEqual([{ id: 1 }]);
    expect(run).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(400);
  });

  it("does not retry permanent query errors", async () => {
    const run = vi.fn().mockResolvedValue({ data: null, error: { message: "column does not exist" } });
    const sleep = vi.fn();

    await withSupabaseRetry<TestResult>(run, { retries: 2, sleep });

    expect(run).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("returns the last transient failure after the finite retry budget", async () => {
    const run = vi.fn().mockResolvedValue({ data: null, error: { message: "Gateway Timeout" } });

    const result = await withSupabaseRetry<TestResult>(run, { retries: 2, sleep: async () => undefined });

    expect(result.error?.message).toBe("Gateway Timeout");
    expect(run).toHaveBeenCalledTimes(3);
  });
});
