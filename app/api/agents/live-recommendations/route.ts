import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { classifyResponse, evaluateArms, markRecommendation, revisionNote, todayUtc, type Bar, type RecKind, type Snap } from "@/lib/live-recommendations/core";
import { collectGuardianOutcomeMarks } from "@/lib/live-recommendations/guardian-store";
import { reportIssue, resolveIssue } from "@/lib/system-health";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Nightly, measure/display only. 1) Sync recommendations shown for the live book (BUY ideas, Guardian stop suggestions, exit signals) into
// the append-only ledger. 2) Mark each against its symbol and SPY and infer from daily holdings whether it was acted on. 3) Evaluate
// alternative Guardian stop rules on the matured BUY ideas as a shadow and write a plain-language revision note. Never places or changes
// an order, stop, or Guardian setting.

const HORIZON = 10;
const day = (iso: string) => String(iso).slice(0, 10);
const chunks = <T,>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

export async function GET(req: NextRequest) {
  const cron = verifyCronSecret(req);
  if (!cron) {
    const gate = await requireOwner();
    if (gate) return gate;
  }
  const svc = createServiceClient();
  const today = todayUtc();

  // 1) Sync sources -> ledger (dedup_key makes this idempotent).
  const proposals = await fetchAllRows((f, t) => svc.from("trade_proposals").select("id,symbol,side,qty,price_at_proposal,thesis,status,created_at,approval_expires_at,account_number,fill_price").eq("market", "us").eq("side", "buy").order("id", { ascending: true }).range(f, t), "trade proposals") as any[];
  const stops = await fetchAllRows((f, t) => svc.from("agentic_position_ledger").select("id,account_id,symbol,avg_cost,detected_at,suggested_stop_price,source").not("suggested_stop_price", "is", null).order("id", { ascending: true }).range(f, t), "guardian stops") as any[];
  const captured = await fetchAllRows((f, t) => svc.from("live_recommendations").select("source_id")
    .eq("source_table", "agentic_position_ledger").not("guardian_contract", "is", null).order("id").range(f, t), "captured Guardian ledger IDs") as any[];
  const capturedLedgerIds = new Set(captured.map(r => String(r.source_id)));
  const exits = await fetchAllRows((f, t) => svc.from("live_exit_ladder_shadow").select("id,account_id,symbol,evaluated_at,action,reason,price,qty_would_exit").eq("market", "us").neq("action", "runner_hold").order("id", { ascending: true }).range(f, t), "exit signals") as any[];

  const fresh = new Map<string, Record<string, unknown>>();
  for (const p of proposals) {
    fresh.set(`tp:${p.id}`, { dedup_key: `tp:${p.id}`, kind: "buy_idea", account_id: String(p.account_number ?? "unknown"), symbol: String(p.symbol).toUpperCase(), issued_at: p.created_at, reference_price: p.price_at_proposal, level_price: null, qty_suggested: p.qty, horizon_sessions: HORIZON, source_table: "trade_proposals", source_id: String(p.id), rationale: p.thesis ? String(p.thesis).slice(0, 400) : null });
  }
  for (const s of stops) {
    if (capturedLedgerIds.has(String(s.id))) continue;
    fresh.set(`apl:${s.id}`, { dedup_key: `apl:${s.id}`, kind: "guardian_stop", account_id: String(s.account_id), symbol: String(s.symbol).toUpperCase(), issued_at: s.detected_at, reference_price: s.avg_cost, level_price: s.suggested_stop_price, qty_suggested: null, horizon_sessions: HORIZON, source_table: "agentic_position_ledger", source_id: String(s.id), rationale: `Suggested stop after a ${s.source} position was detected.` });
  }
  for (const x of exits) {
    const key = `lx:${x.account_id}:${x.symbol}:${x.action}:${day(x.evaluated_at)}`;
    if (fresh.has(key)) continue;
    fresh.set(key, { dedup_key: key, kind: "exit_signal", account_id: String(x.account_id), symbol: String(x.symbol).toUpperCase(), issued_at: x.evaluated_at, reference_price: x.price, level_price: null, qty_suggested: x.qty_would_exit, horizon_sessions: HORIZON, source_table: "live_exit_ladder_shadow", source_id: String(x.id), rationale: `${x.action}: ${x.reason ?? ""}`.slice(0, 400) });
  }
  for (const part of chunks([...fresh.values()], 200)) {
    const { error } = await svc.from("live_recommendations").upsert(part, { onConflict: "dedup_key", ignoreDuplicates: true });
    if (error) return NextResponse.json({ ok: false, error: `ledger sync failed: ${error.message}` }, { status: 500 });
  }
  const recs = await fetchAllRows((f, t) => svc.from("live_recommendations").select("*").eq("market", "us").order("id", { ascending: true }).range(f, t), "recommendations") as any[];

  // 2) Inputs for marking: daily holdings snapshots and price bars.
  const symbols = [...new Set(recs.map((r) => r.symbol as string))];
  const minIssued = recs.reduce((m, r) => (day(r.issued_at) < m ? day(r.issued_at) : m), today);
  const barsFrom = new Date(Date.parse(minIssued) - 60 * 86400000).toISOString().slice(0, 10);
  const snapRows = await fetchAllRows((f, t) => svc.from("holding_risk_snapshots").select("id,captured_on,account_id,symbol,qty,average_cost").eq("market", "us").neq("account_id", "internal").in("symbol", symbols).gte("captured_on", minIssued.slice(0, 7) + "-01").order("id", { ascending: true }).range(f, t), "holding snapshots") as any[];
  const snapsBySymbol = new Map<string, Snap[]>();
  for (const r of snapRows) (snapsBySymbol.get(r.symbol) ?? snapsBySymbol.set(r.symbol, []).get(r.symbol)!).push({ date: String(r.captured_on), qty: Number(r.qty ?? 0), avgCost: r.average_cost == null ? null : Number(r.average_cost), accountId: String(r.account_id) });
  for (const list of snapsBySymbol.values()) list.sort((a, b) => a.date.localeCompare(b.date));

  const barRows = await fetchAllRows((f, t) => svc.from("price_cache").select("symbol,date,open,high,low,close").in("symbol", [...symbols, "SPY"]).gte("date", barsFrom).order("symbol", { ascending: true }).order("date", { ascending: true }).range(f, t), "price bars") as any[];
  const barsBySymbol = new Map<string, Bar[]>();
  for (const r of barRows) {
    const c = Number(r.close); if (!Number.isFinite(c)) continue;
    const b: Bar = { date: String(r.date), open: Number(r.open ?? c), high: Number(r.high ?? c), low: Number(r.low ?? c), close: c };
    (barsBySymbol.get(r.symbol) ?? barsBySymbol.set(r.symbol, []).get(r.symbol)!).push(b);
  }
  const spyBars = barsBySymbol.get("SPY") ?? [];
  const propById = new Map(proposals.map((p) => [String(p.id), p]));

  const marks: Record<string, unknown>[] = [];
  const counts: Record<string, number> = {};
  for (const rec of recs) {
    if (rec.kind === "guardian_stop") continue; // Exact-stop producer owns these marks, including legacy/unknown rows.
    const kind = rec.kind as RecKind;
    const bars = barsBySymbol.get(rec.symbol) ?? [];
    const snaps = snapsBySymbol.get(rec.symbol) ?? [];
    const issuedDate = day(rec.issued_at);
    const ref = rec.reference_price == null ? null : Number(rec.reference_price);
    const level = rec.level_price == null ? null : Number(rec.level_price);
    const markArgs = { kind, issuedDate, referencePrice: ref, levelPrice: level, bars, spyBars };
    const m0 = markRecommendation(markArgs);
    const prop = kind === "buy_idea" ? propById.get(String(rec.source_id)) : null;
    const resp = classifyResponse({
      kind, issuedDate, horizonSessions: rec.horizon_sessions, sessionsSince: m0.sessionsSince, qtySuggested: rec.qty_suggested == null ? null : Number(rec.qty_suggested), referencePrice: ref,
      proposalStatus: prop?.status ?? null, approvalExpired: prop?.approval_expires_at ? Date.parse(prop.approval_expires_at) < Date.now() : false, snaps, levelTouched: m0.levelTouched === true,
    });
    // Actual P/L only when the position is still held in the account that acted on it; otherwise the mark stays hypothetical.
    const acctForHeld = resp.status === "taken" ? resp.account : kind === "buy_idea" ? null : String(rec.account_id);
    const latest = acctForHeld ? [...snaps].reverse().find((s) => s.accountId === acctForHeld) : null;
    const held = latest && latest.qty > 0 && latest.avgCost != null ? { avgCost: latest.avgCost, qty: latest.qty } : null;
    const m = held ? markRecommendation({ ...markArgs, held }) : m0;
    counts[resp.status] = (counts[resp.status] ?? 0) + 1;
    marks.push({
      rec_id: rec.id, marked_on: today, status: resp.status, response_account: resp.account, response_detail: resp.detail, sessions_since: m.sessionsSince, last_price: m.lastPrice,
      symbol_return_pct: m.symbolReturnPct, benchmark_return_pct: m.benchmarkReturnPct, excess_pct: m.excessPct, pnl_pct: m.pnlPct, pnl_basis: m.pnlBasis,
      level_touched: m.levelTouched, level_touched_on: m.levelTouchedOn, pnl_if_level_pct: m.pnlIfLevelPct,
    });
  }
  for (const part of chunks(marks, 200)) {
    const { error } = await svc.from("live_recommendation_marks").upsert(part, { onConflict: "rec_id,marked_on", ignoreDuplicates: true });
    if (error) return NextResponse.json({ ok: false, error: `mark write failed: ${error.message}` }, { status: 500 });
  }

  // 3) Guardian stop-rule shadow on matured BUY ideas (hypothetical entry at the proposal price).
  const ideas = recs.filter((r) => r.kind === "buy_idea" && r.reference_price != null).map((r) => ({ symbol: r.symbol as string, issuedDate: day(r.issued_at), entry: Number(r.reference_price), bars: barsBySymbol.get(r.symbol) ?? [] }));
  const ev = evaluateArms(ideas, HORIZON);
  const { error: revError } = await svc.from("live_guardian_revisions").upsert({ revised_on: today, sample: ev.sample, distinct_symbols: ev.distinctSymbols, arms: ev.arms, note: revisionNote(ev, HORIZON) }, { onConflict: "revised_on", ignoreDuplicates: true });
  if (revError) return NextResponse.json({ ok: false, error: `revision write failed: ${revError.message}` }, { status: 500 });

  let guardian;
  try {
    guardian = await collectGuardianOutcomeMarks(svc);
    if (Object.values(guardian).some(row => row.deferred > 0 || row.failed > 0 || row.unavailable > 0)) {
      await reportIssue({ issueKey: "guardian-stop-outcome-producer", severity: "warn", category: "data", title: "Guardian outcome collection is incomplete",
        detail: `Raw history has a shared 45-second budget and 20-name/market cap, oldest-attempt first. Deferred US=${guardian.us.deferred}, India=${guardian.india.deferred}; failed US=${guardian.us.failed}, India=${guardian.india.failed}; unavailable horizon cells US=${guardian.us.unavailable}, India=${guardian.india.unavailable}. Unavailable rows are not zero returns.` }, svc);
    } else await resolveIssue("guardian-stop-outcome-producer", svc);
  } catch {
    await reportIssue({ issueKey: "guardian-stop-outcome-producer", severity: "warn", category: "data",
      title: "Guardian stop outcome evaluation failed", detail: "Stored stop suggestions could not be evaluated or persisted. Performance is unavailable, not zero; inspect the nightly recommendation producer." }, svc);
    await svc.from("agent_runs").insert({ agent_type: "live_recommendations", market: "us", status: "error", completed_at: new Date().toISOString(), result_summary: "Guardian outcome producer failed; behavior changed=false" });
    return NextResponse.json({ ok: false, error: "Guardian outcome producer failed; see System Health" }, { status: 500 });
  }
  await svc.from("agent_runs").insert({ agent_type: "live_recommendations", market: "india", status: guardian.india.failed || guardian.india.unavailable || guardian.india.deferred ? "error" : "done", completed_at: new Date().toISOString(),
    result_summary: `Exact-stop measurement: ${guardian.india.suggestions} stored suggestions, ${guardian.india.ready} matured horizon cells; no suggestions is expected until an app producer exists; behavior changed=false` });

  await svc.from("agent_runs").insert({
    agent_type: "live_recommendations", status: guardian.us.failed || guardian.us.unavailable || guardian.us.deferred ? "error" : "done", market: "us", symbols: [], trigger_source: cron ? "scheduled" : "manual",
    signals_written: 0, completed_at: new Date().toISOString(), tokens_input: 0, tokens_output: 0, claude_calls: 0,
    result_summary: `Shadow only: ${recs.length} recommendations marked (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}); ${ev.sample} matured ideas in stop-rule shadow; behavior changed=false`,
  });
  return NextResponse.json({ ok: true, shadowOnly: true, behaviorChanged: false, recommendations: recs.length, statuses: counts, armSample: ev.sample, guardian });
}

export const POST = GET;
