const SYMBOLS = new Set(["SOXL", "SOXS", "TQQQ", "SQQQ"]);

/** Read-only operational history, kept separate from the earlier research row. */
export async function readLeveragedJournalDecisions(svc: any, symbols: string[], date: string, now = new Date()) {
  const bySymbol = new Map<string, any>();
  let failed = false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { bySymbol, failed: true };
  // US regular-session paper doors fit inside this UTC envelope in both DST
  // seasons, including early closes. Do not let the next day's last run mask it.
  const start = `${date}T09:00:00.000Z`;
  const end = new Date(Math.min(Date.parse(`${date}T23:59:59.999Z`), now.getTime())).toISOString();
  await Promise.all([...new Set(symbols)].filter(symbol => SYMBOLS.has(symbol)).map(async symbol => {
    try {
      const { data, error } = await svc.from("agent_runs").select("started_at,status,result_summary")
        .eq("agent_type", `${symbol.toLowerCase()}_cron`).eq("market", "us")
        .gte("started_at", start).lte("started_at", end)
        .not("result_summary", "like", '%"reason":"outside_entry_window"%')
        .order("started_at", { ascending: false }).limit(1).maybeSingle();
      if (error) { failed = true; return; }
      if (!data) return;
      const body = JSON.parse(data.result_summary);
      if (!body || typeof body !== "object" || Array.isArray(body)) { failed = true; return; }
      bySymbol.set(symbol, { at: data.started_at, status: data.status,
        outcome: typeof body.status === "string" ? body.status : "unknown",
        reason: typeof body.reason === "string" ? body.reason : "not_recorded",
        setup: body.setup && typeof body.setup === "object" ? body.setup : null,
        funding: body.funding && typeof body.funding === "object" ? body.funding : null,
        research: body.research && typeof body.research === "object" ? body.research : null });
    } catch { failed = true; }
  }));
  return { bySymbol, failed };
}
