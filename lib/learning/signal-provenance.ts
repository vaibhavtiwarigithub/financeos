export type SignalProvenance = { label: string; market: "us" | "india"; sessionValidated: boolean; asOfSession: string | null };

/** Shared source-session authority; batches stay below the PostgREST row cap. */
export async function signalProvenance(svc: any, ids: string[]): Promise<Map<string, SignalProvenance>> {
  const result = new Map<string, SignalProvenance>();
  const unique = [...new Set(ids)];
  for (let index = 0; index < unique.length; index += 500) {
    const { data, error } = await svc.from("agent_signals")
      .select("id,agent_label,market,session_validated,as_of_session").in("id", unique.slice(index, index + 500));
    if (error) throw new Error(`signal provenance query failed: ${error.message}`);
    for (const row of data ?? []) result.set(String(row.id), {
      label: String(row.agent_label ?? "research"), market: row.market,
      sessionValidated: row.session_validated === true, asOfSession: row.as_of_session ?? null,
    });
  }
  return result;
}
