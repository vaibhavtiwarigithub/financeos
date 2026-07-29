import { describe, expect, it, vi } from "vitest";
import { universeFingerprint } from "./pit-universe";
import { loadPitSnapshot, persistPitSnapshot } from "./pit-snapshot";

const snapshot = {
  ok: true as const,
  market: "us" as const,
  asOf: "2026-07-24",
  policyVersion: "us_pit_adv20_top400_v2",
  source: "massive_pit_tickers_trailing_adv20",
  fingerprint: "abc123",
  members: [{ symbol: "AAPL", advValue: 10, advRank: 1, delistedAt: null }],
};

describe("persistPitSnapshot", () => {
  it("uses only the locked persistence RPC and validates its acknowledgement", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { status: "inserted", member_count: 1, fingerprint: "abc123" },
      error: null,
    });
    await expect(persistPitSnapshot({ rpc }, snapshot)).resolves.toMatchObject({ status: "inserted" });
    expect(rpc).toHaveBeenCalledWith("persist_edge_pit_snapshot", expect.objectContaining({
      p_market: "us",
      p_as_of_date: "2026-07-24",
      p_members: snapshot.members,
    }));
  });

  it("fails closed on a mismatched acknowledgement", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { status: "existing", member_count: 2, fingerprint: "different" },
      error: null,
    });
    await expect(persistPitSnapshot({ rpc }, snapshot)).rejects.toThrow("invalid acknowledgement");
  });

  it("loads and independently verifies a persisted ranked snapshot", async () => {
    const members = [{ symbol: "AAPL", advValue: 10, advRank: 1, delistedAt: null }];
    const fingerprint = universeFingerprint("us", "2026-07-24", snapshot.policyVersion, members);
    const response = {
      data: [{
        symbol: "AAPL",
        adv_value: 10,
        adv_rank: 1,
        delisted_at: null,
        membership_source: snapshot.source,
        snapshot_fingerprint: fingerprint,
      }],
      error: null,
    };
    const query: any = {
      select: () => query,
      eq: () => query,
      order: () => Promise.resolve(response),
    };
    const client = { from: () => query };
    await expect(loadPitSnapshot(client, {
      market: "us",
      asOf: "2026-07-24",
      policyVersion: snapshot.policyVersion,
      minSymbols: 1,
    })).resolves.toMatchObject({ fingerprint, members });
  });
});
