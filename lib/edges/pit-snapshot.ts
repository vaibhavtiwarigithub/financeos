import type { Market } from "@/lib/edges/types";
import {
  universeFingerprint,
  type PitUniverseResult,
} from "@/lib/edges/pit-universe";

export interface PitSnapshotWriteResult {
  status: "inserted" | "existing";
  member_count: number;
  fingerprint: string;
  universe_id?: string;
}

/**
 * Persist one resolved PIT universe through the locked append-only RPC.
 * The caller supplies a service-role client; this helper is never browser-safe.
 */
export async function persistPitSnapshot(
  client: { rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> },
  snapshot: Extract<PitUniverseResult, { ok: true }>,
): Promise<PitSnapshotWriteResult> {
  const { data, error } = await client.rpc("persist_edge_pit_snapshot", {
    p_market: snapshot.market,
    p_as_of_date: snapshot.asOf,
    p_policy_version: snapshot.policyVersion,
    p_source: snapshot.source,
    p_fingerprint: snapshot.fingerprint,
    p_members: snapshot.members,
  });
  if (error) throw new Error(`persist_edge_pit_snapshot failed: ${error.message}`);

  const result = data as Partial<PitSnapshotWriteResult> | null;
  if (
    !result ||
    (result.status !== "inserted" && result.status !== "existing") ||
    result.member_count !== snapshot.members.length ||
    result.fingerprint !== snapshot.fingerprint
  ) {
    throw new Error("persist_edge_pit_snapshot returned an invalid acknowledgement");
  }
  return result as PitSnapshotWriteResult;
}

/** Reuse a previously persisted exact snapshot before spending provider quota. */
export async function loadPitSnapshot(
  client: any,
  opts: { market: Market; asOf: string; policyVersion: string; minSymbols: number },
): Promise<Extract<PitUniverseResult, { ok: true }> | null> {
  const { data, error } = await client
    .from("edge_universe_members")
    .select("symbol, adv_value, adv_rank, delisted_at, membership_source, snapshot_fingerprint")
    .eq("market", opts.market)
    .eq("as_of_date", opts.asOf)
    .eq("pit_policy_version", opts.policyVersion)
    .eq("is_point_in_time", true)
    .order("adv_rank", { ascending: true });
  if (error) throw new Error(`PIT snapshot read failed: ${error.message}`);
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  if (!rows.length) return null;
  if (rows.length < opts.minSymbols) throw new Error("Persisted PIT snapshot is below minSymbols");

  const fingerprints = new Set(rows.map((row) => String(row.snapshot_fingerprint ?? "")));
  const sources = new Set(rows.map((row) => String(row.membership_source ?? "")));
  if (fingerprints.size !== 1 || fingerprints.has("") || sources.size !== 1 || sources.has("")) {
    throw new Error("Persisted PIT snapshot has inconsistent provenance");
  }

  const members = rows.map((row, index) => {
    const advValue = Number(row.adv_value);
    const advRank = Number(row.adv_rank);
    const symbol = String(row.symbol ?? "");
    if (!symbol || !Number.isFinite(advValue) || advValue <= 0 || advRank !== index + 1) {
      throw new Error("Persisted PIT snapshot has invalid member ordering");
    }
    return {
      symbol,
      advValue,
      advRank,
      delistedAt: row.delisted_at ? String(row.delisted_at) : null,
    };
  });

  const fingerprint = [...fingerprints][0];
  if (universeFingerprint(opts.market, opts.asOf, opts.policyVersion, members) !== fingerprint) {
    throw new Error("Persisted PIT snapshot fingerprint does not match its members");
  }

  return {
    ok: true,
    market: opts.market,
    asOf: opts.asOf,
    policyVersion: opts.policyVersion,
    source: [...sources][0],
    fingerprint,
    members,
  };
}
