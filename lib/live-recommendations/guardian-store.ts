import type { GuardianOutcomePayload, GuardianOutcomeRow, GuardianResponseEvidence } from "@/types";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { evaluateGuardianStop, GUARDIAN_HORIZONS, GUARDIAN_VERSION, guardianOverlapExclusions, guardianResponse, summarizeGuardianStops, validGuardianContract, type StopRecommendation } from "./guardian-stop";
import { fetchYahooRawReplaySeries } from "@/lib/data/yahoo-candles";
import { researchSessionCloseAt } from "@/lib/trading/market-calendar";

const COLS = "id,market,account_id,symbol,issued_at,level_price,qty_suggested,source_table,source_id,guardian_contract";
async function stops(svc: any, market: "us" | "india") {
  const rows = await fetchAllRows((f, t) => svc.from("live_recommendations").select(COLS)
    .eq("kind", "guardian_stop").eq("market", market).order("issued_at", { ascending: true }).order("id", { ascending: true }).range(f, t), "frozen Guardian suggestions") as any[];
  return rows.map(r => ({ ...r, id: Number(r.id), level_price: r.level_price == null ? null : Number(r.level_price),
    qty_suggested: r.qty_suggested == null ? null : Number(r.qty_suggested) })) as StopRecommendation[];
}
const rowFor = (r: StopRecommendation, outcomes: GuardianOutcomeRow["outcomes"], response: GuardianResponseEvidence): GuardianOutcomeRow => ({
  id: r.id, symbol: r.symbol, issuedAt: r.issued_at, stop: r.level_price, qty: r.qty_suggested,
  source: r.source_table, version: r.guardian_contract?.version ?? null,
  stopFormulaVersion: r.guardian_contract?.stop_formula_version ?? "unrecorded", outcomes, response,
});

/** Existing scheduled producer; raw replay source only, no LLM or broker call/mutation. */
export async function collectGuardianOutcomeMarks(svc: any, asOf = new Date()) {
  const deadline = Date.now() + 45_000;
  const totals: Record<string, { suggestions: number; ready: number; deferred: number; failed: number; unavailable: number }> = {};
  for (const market of ["us", "india"] as const) {
    const marketDeadline = Math.min(deadline, Date.now() + 22_000);
    const recs = await stops(svc, market);
    totals[market] = { suggestions: recs.length, ready: 0, deferred: 0, failed: 0, unavailable: 0 };
    if (!recs.length) continue;
    const priorRows: any[] = [];
    for (let i = 0; i < recs.length; i += 200) priorRows.push(...await fetchAllRows((f, t) => svc.from("live_recommendation_marks")
      .select("id,rec_id,marked_on,guardian_outcomes").in("rec_id", recs.slice(i, i + 200).map(r => r.id))
      .not("guardian_outcomes", "is", null).order("marked_on").order("id").range(f, t), "Guardian frozen matured marks"));
    const frozen = new Map<string, any>();
    const attemptedAt = new Map<string, string>();
    for (const row of priorRows) if (row.guardian_outcomes?.version === GUARDIAN_VERSION)
      { for (const o of row.guardian_outcomes.outcomes ?? []) if (o.state === "ready" && !frozen.has(`${row.rec_id}:${o.horizon}`)) frozen.set(`${row.rec_id}:${o.horizon}`, o);
        const symbol = recs.find(r => r.id === Number(row.rec_id))?.symbol;
        const stamp = row.guardian_outcomes.source_attempted_at;
        if (symbol && typeof stamp === "string" && stamp > (attemptedAt.get(symbol) ?? "")) attemptedAt.set(symbol, stamp); }
    const excluded = guardianOverlapExclusions(recs);
    const pendingSymbols = [...new Set(recs.filter(r => validGuardianContract(r) && !excluded.has(r.id)
      && GUARDIAN_HORIZONS.some(h => !frozen.has(`${r.id}:${h}`) && evaluateGuardianStop(r, [], h, asOf).state !== "immature")).map(r => r.symbol))]
      .sort((a, b) => (attemptedAt.get(a) ?? "").localeCompare(attemptedAt.get(b) ?? "") || a.localeCompare(b));
    const symbols = pendingSymbols.slice(0, 20);
    totals[market].deferred = pendingSymbols.length - symbols.length;
    const raw = new Map<string, Awaited<ReturnType<typeof fetchYahooRawReplaySeries>>>();
    for (let i = 0; i < symbols.length; i += 3) {
      // Reserve time for both markets' database writes; each existing fetch has an 8s timeout.
      if (Date.now() > marketDeadline - 10_000) { totals[market].deferred += symbols.length - i; break; }
      await Promise.all(symbols.slice(i, i + 3).map(async symbol => {
        try { raw.set(symbol, await fetchYahooRawReplaySeries(symbol, "1y")); }
        catch { raw.set(symbol, null); }
        if (!raw.get(symbol)?.candles.length) totals[market].failed++;
      }));
    }
    const knownActions = raw.size ? await fetchAllRows((f, t) => svc.from("corporate_actions")
      .select("id,symbol,ex_date,effective_date").in("symbol", [...raw.keys()]).order("id").range(f, t), "Guardian known corporate actions") as any[] : [];
    if (knownActions.some(a => !/^\d{4}-\d{2}-\d{2}$/.test(String(a.ex_date ?? a.effective_date ?? ""))))
      throw new Error("Guardian corporate-action date cannot be verified");
    const plans = await fetchAllRows((f, t) => svc.from("guardian_protection_plans")
      .select("id,ledger_entry_id,market,account_id,symbol,status,trigger_proposal_id").eq("market", market)
      .order("id").range(f, t), "Guardian response plans") as any[];
    const proposalIds = [...new Set(plans.map(p => p.trigger_proposal_id).filter((id: unknown) => id != null))];
    const fills: any[] = [];
    for (let i = 0; i < proposalIds.length; i += 100) {
      fills.push(...await fetchAllRows((f, t) => svc.from("broker_orders")
        .select("id,proposal_id,market,broker_env,broker_account_id,symbol,side,status,filled_qty,avg_fill_price,submitted_at,closed_at,broker_order_id,tainted")
        .in("proposal_id", proposalIds.slice(i, i + 100)).order("id").range(f, t), "Guardian linked fill evidence"));
    }
    const marks = recs.map(rec => {
      const response = guardianResponse(rec, plans, fills.map(f => ({ ...f, filled_qty: f.filled_qty == null ? null : Number(f.filled_qty), avg_fill_price: f.avg_fill_price == null ? null : Number(f.avg_fill_price) })), asOf);
      const series = raw.get(rec.symbol);
      const outcomes = GUARDIAN_HORIZONS.map(h => {
        const actionDates = [...(series?.corporateActions.map(a => a.session) ?? []),
          ...knownActions.filter(a => a.symbol === rec.symbol).flatMap(a => [a.ex_date, a.effective_date].filter(Boolean))];
        const result = frozen.get(`${rec.id}:${h}`) ?? evaluateGuardianStop(rec, series?.candles ?? [], h, asOf, excluded.get(rec.id), actionDates);
        const end = result.endSession ? researchSessionCloseAt(market, result.endSession) : null;
        return { ...result, confirmedSaleVsHoldMoney: result.state === "ready" && response.fillQty && response.fillPrice && response.filledAt && end != null
          && Date.parse(response.filledAt) <= end ? response.fillQty * (response.fillPrice - result.holdPrice!) : null };
      });
      totals[market].ready += outcomes.filter(o => o.state === "ready").length;
      totals[market].unavailable += outcomes.filter(o => o.state === "missing_data").length;
      return { rec_id: rec.id, marked_on: asOf.toISOString().slice(0, 10), status: "watching", sessions_since: 0,
        response_detail: response.reason, guardian_outcomes: { version: GUARDIAN_VERSION, evaluated_at: asOf.toISOString(),
          source: "yahoo_chart_v8_raw_replay", source_attempted_at: raw.has(rec.symbol) ? asOf.toISOString() : attemptedAt.get(rec.symbol) ?? null,
          outcomes, response } };
    });
    for (let i = 0; i < marks.length; i += 200) {
      const { error } = await svc.from("live_recommendation_marks").upsert(marks.slice(i, i + 200), { onConflict: "rec_id,marked_on", ignoreDuplicates: true });
      if (error) throw new Error(`Guardian ${market} outcome write failed`);
    }
  }
  return totals;
}

/** Both owner scorecard routes read identical persisted outcome semantics. */
export async function loadGuardianOutcomeScorecard(svc: any, market: "us" | "india"): Promise<GuardianOutcomePayload> {
  const recs = await stops(svc, market); const marks: any[] = [];
  for (let i = 0; i < recs.length; i += 200) {
    marks.push(...await fetchAllRows((f, t) => svc.from("live_recommendation_marks").select("id,rec_id,marked_on,guardian_outcomes")
      .in("rec_id", recs.slice(i, i + 200).map(r => r.id)).not("guardian_outcomes", "is", null)
      .order("marked_on", { ascending: true }).order("id", { ascending: true }).range(f, t), "persisted Guardian outcomes"));
  }
  const latest = new Map<number, any>(); let evaluatedAt: string | null = null;
  for (const mark of marks) {
    const value = mark.guardian_outcomes;
    if (value?.version !== GUARDIAN_VERSION || !Array.isArray(value.outcomes)) continue;
    latest.set(Number(mark.rec_id), value);
    if (typeof value.evaluated_at === "string" && (!evaluatedAt || value.evaluated_at > evaluatedAt)) evaluatedAt = value.evaluated_at;
  }
  const rows = recs.map(rec => {
    const m = latest.get(rec.id);
    return rowFor(rec, m?.outcomes ?? GUARDIAN_HORIZONS.map(horizon => ({ horizon,
      state: rec.guardian_contract ? "missing_data" : "legacy", reason: rec.guardian_contract ? "Awaiting a successful nightly evaluation." : "No frozen contract; historical suggestion is ungraded." })),
    m?.response ?? { state: "unknown", reason: "No persisted linked fill evidence." });
  });
  return { market, currency: market === "us" ? "USD" : "INR", evaluatedAt, suggestions: rows.length,
    legacy: recs.filter(r => !r.guardian_contract).length, summary: summarizeGuardianStops(rows),
    rows: rows.reverse().slice(0, 100), rowsTruncated: rows.length > 100 };
}
