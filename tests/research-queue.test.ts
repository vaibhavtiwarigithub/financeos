import { describe, expect, it, vi } from "vitest";
import { applyCandidateCarryForward, completeDeferred } from "@/lib/research-queue";

describe("research queue completion semantics", () => {
  it("does not remove a selected queued symbol before processing succeeds", async () => {
    const from = vi.fn();
    const svc = { from };

    await expect(applyCandidateCarryForward(svc, "us", ["AMD"], 1)).resolves.toEqual(["AMD"]);
    expect(from).not.toHaveBeenCalled();
  });

  it("removes the queued symbol only when completion is recorded", async () => {
    const inCall = vi.fn().mockResolvedValue({ error: null });
    const eq = vi.fn().mockReturnValue({ in: inCall });
    const del = vi.fn().mockReturnValue({ eq });
    const from = vi.fn().mockReturnValue({ delete: del });

    await completeDeferred({ from }, "us", ["amd", "AMD"]);

    expect(from).toHaveBeenCalledWith("research_queue");
    expect(eq).toHaveBeenCalledWith("market", "us");
    expect(inCall).toHaveBeenCalledWith("symbol", ["AMD"]);
  });
});
