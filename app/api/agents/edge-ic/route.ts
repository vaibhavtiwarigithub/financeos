import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { verifyCronSecret } from "@/lib/auth/cron";
import { requireOwner } from "@/lib/auth/require-owner";
import { computeEdgeIC } from "@/lib/edges/ic";
import { EDGES } from "@/lib/edges/registry";
import { liquidUniverse } from "@/lib/edges/universe";
import type { Market } from "@/lib/edges/types";
import { EDGE_EVIDENCE_QUALITY, edgeHealthKey } from "@/lib/edges/evidence";
import { reportIssue, resolveIssue } from "@/lib/system-health";
import { knownSectorForSymbol } from "@/lib/portfolio-risk";
import crypto from "node:crypto";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// EdgeIC (P1) — computes rolling Information Coefficient per edge × horizon on the
// broad historical candle universe and writes edge_ic_history + a market-scoped
// ADVISORY lifecycle status. MEASURE-ONLY: writes only edge analytics/health rows.
// Never touches agent_signals, paper fills, sizing, or any live-money path. The
// status is advisory ("shadow_eligible" means it MAY enter shadow later — it does
// NOT grant trade permission). Bounded (maxSymbols/maxDates caps). Idempotent.

const MAX_SYMBOLS_CAP = 200;
const DEFAULT_MAX_SYMBOLS = 40;

async function seedCatalog(svc: any) {
  const rows = EDGES.map(edge => ({
    edge_id: edge.id,
    name: edge.name,
    category: edge.category,
    formula_spec: null,
    inputs: [],
    rationale: edge.rationale,
    expected_sign: edge.expectedSign,
    horizon_days: edge.horizonDays,
    data_source: edge.dataSource,
    reference_urls: edge.references,
    status: "measure_only",
  }));
  const { error } = await svc.from("edge_catalog").upsert(rows, {
    onConflict: "edge_id", ignoreDuplicates: true,
  });
  if (error) throw new Error(`edge_catalog seed failed: ${error.message}`);
}

async function buildUniverse(svc: any, market: Market, maxSymbols: number, mode: string, offset: number): Promise<string[]> {
  if (mode === "liquid") return liquidUniverse(market).slice(offset, offset + maxSymbols);
  try {
    if (market === "us") {
      const nowIso = new Date().toISOString();
      const { data } = await svc.from("watchlist").select("symbol")
        .or(`expires_at.is.null,expires_at.gt.${nowIso}`).limit(maxSymbols * 3);
      return [...new Set((data ?? []).map((r: any) => String(r.symbol ?? "").toUpperCase().trim()).filter(Boolean))].slice(0, maxSymbols) as string[];
    }
    const { data } = await svc.from("india_screen_cache").select("symbol").not("symbol", "is", null).limit(maxSymbols * 4);
    const seen = new Set<string>(); const syms: string[] = [];
    for (const r of (data ?? []) as any[]) {
      const raw = String(r.symbol ?? "").toUpperCase().trim();
      if (!raw) continue;
      const sym = raw.endsWith(".NS") || raw.endsWith(".BO") ? raw : `${raw}.NS`;
      if (seen.has(sym)) continue; seen.add(sym); syms.push(sym);
      if (syms.length >= maxSymbols) break;
    }
    return syms;
  } catch { return []; }
}

async function loadSectorMap(svc: any, market: Market, symbols: string[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = Object.fromEntries(
    symbols.map(symbol => [symbol, knownSectorForSymbol(symbol, market)]),
  );
  const { data, error } = await svc
    .from("symbol_profiles")
    .select("symbol,sector")
    .eq("market", market)
    .in("symbol", symbols);
  if (error) return out;
  for (const row of data ?? []) {
    const symbol = String(row.symbol ?? "").toUpperCase().trim();
    const sector = typeof row.sector === "string" && row.sector.trim() ? row.sector.trim() : null;
    if (symbol && sector) out[symbol] = sector;
  }
  return out;
}

export async function POST(req: NextRequest) {
  const svc = createServiceClient();
  let runId: string | null = null;
  let markets: Market[] = [];
  try {
    const isCron = verifyCronSecret(req);
    if (!isCron) {
      const gate = await requireOwner();
      if (gate) return gate;
    }

    const url = new URL(req.url);
    const marketParam = url.searchParams.get("market") ?? "both";
    const maxSymbols = Math.max(1, Math.min(MAX_SYMBOLS_CAP, Number(url.searchParams.get("maxSymbols") ?? DEFAULT_MAX_SYMBOLS) || DEFAULT_MAX_SYMBOLS));
    const maxDates = Math.max(5, Math.min(120, Number(url.searchParams.get("maxDates") ?? 60) || 60));
    const stepDays = Math.max(1, Math.min(20, Number(url.searchParams.get("stepDays") ?? 5) || 5));
    const universeMode = url.searchParams.get("universe") === "liquid" ? "liquid" : "watchlist";
    const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
    // Deeper default history for IC so it spans multiple years of forward returns.
    const historyDays = Math.max(120, Math.min(1600, Number(url.searchParams.get("historyDays") ?? 1000) || 1000));
    markets = marketParam === "us" ? ["us"] : marketParam === "india" ? ["india"] : ["us", "india"];

    const { data: runRow } = await svc.from("agent_runs").insert({
      agent_type: "edge_ic", status: "running", trigger_source: isCron ? "scheduled" : "manual",
      market: markets.length === 1 ? markets[0] : null,
    } as any).select().single();
    runId = (runRow as any)?.id ?? null;

    await seedCatalog(svc);

    const results: Record<string, any> = {};
    for (const market of markets) {
      const symbols = await buildUniverse(svc, market, maxSymbols, universeMode, offset);
      if (!symbols.length) {
        results[market] = { symbols: 0, icRows: 0 };
        await reportIssue({
          issueKey: edgeHealthKey("ic", market), severity: "warn", category: "data",
          title: `EdgeIC has no ${market.toUpperCase()} universe`,
          detail: `Universe mode=${universeMode}, offset=${offset}, cap=${maxSymbols}. No lifecycle status changed.`,
        }, svc);
        continue;
      }

      const sectors = await loadSectorMap(svc, market, symbols);
      const { rows, catalogStatus, report } = await computeEdgeIC({
        market, symbols, maxDates, stepDays, candleDays: historyDays, sectors,
      });

      let icWritten = 0;
      if (rows.length) {
        const icRows = rows.map(r => {
          const runFingerprint = crypto.createHash("sha256").update(JSON.stringify({
            edgeId: r.edgeId,
            market: r.market,
            windowEnd: r.windowEnd,
            horizon: r.horizon,
            segmentType: r.segmentType,
            segmentValue: r.segmentValue,
            datasetFingerprint: report.datasetFingerprint,
            maxDates,
            stepDays,
            historyDays,
          })).digest("hex");
          return {
            edge_id: r.edgeId, market: r.market, window_end: r.windowEnd, horizon: r.horizon,
            segment_type: r.segmentType, segment_value: r.segmentValue,
            formula_version: r.edgeId, dataset_fingerprint: report.datasetFingerprint,
            run_fingerprint: runFingerprint,
            ic: Number.isFinite(r.meanIC) ? r.meanIC : null,
            ic_ir: Number.isFinite(r.icIR) ? r.icIR : null,
            t_stat: Number.isFinite(r.tStat) ? r.tStat : null,
            net_of_fee_ic: null,   // cost/turnover-adjusted alpha is the P5 long-only bucket test
            turnover: null,
            status_after: r.statusAfter,
            n_obs: r.nObs,
            universe_size: report.symbolsResolved,
            as_of_dates: report.asOfDates,
            step_days: stepDays,
            history_days: historyDays,
            evidence_quality: EDGE_EVIDENCE_QUALITY,
            provider_report: report,
          };
        });
        const { data: inserted, error: icError } = await svc.from("edge_ic_history")
          .upsert(icRows, { onConflict: "run_fingerprint", ignoreDuplicates: true })
          .select("id");
        if (icError) throw new Error(`edge IC write failed (${market}): ${icError.message}`);
        icWritten = inserted?.length ?? 0;
      }

      // Advisory status is market-scoped. The catalog's global status is not an
      // evidence state and must not be overwritten by whichever market ran last.
      for (const [edgeId, status] of Object.entries(catalogStatus)) {
        const edgeRows = rows.filter(r => r.edgeId === edgeId && r.segmentType === "market");
        const horizonStatuses = Object.fromEntries(edgeRows.map(r => [String(r.horizon), {
          status: r.statusAfter, nObs: r.nObs, ic: r.meanIC, tStat: r.tStat,
        }]));
        const nObsMin = edgeRows.length ? Math.min(...edgeRows.map(r => r.nObs)) : 0;
        const latestWindowEnd = edgeRows[0]?.windowEnd ?? null;
        const { error: statusError } = await svc.from("edge_market_status").upsert({
          edge_id: edgeId, market, status, latest_window_end: latestWindowEnd,
          n_obs_min: nObsMin, evidence_quality: EDGE_EVIDENCE_QUALITY,
          horizon_statuses: horizonStatuses, updated_at: new Date().toISOString(),
        }, { onConflict: "edge_id,market" });
        if (statusError) throw new Error(`edge market status failed (${market}/${edgeId}): ${statusError.message}`);
      }

      results[market] = { symbols: symbols.length, icRowsEvaluated: rows.length, icRowsInserted: icWritten, report,
        shadowEligible: Object.entries(catalogStatus).filter(([, s]) => s === "shadow_eligible").map(([e]) => e) };
      if (rows.length === 0) {
        await reportIssue({
          issueKey: edgeHealthKey("ic", market), severity: "warn", category: "data",
          title: `EdgeIC produced no ${market.toUpperCase()} evaluation`,
          detail: `Universe=${symbols.length}; resolved=${report.symbolsResolved}; dates=${report.asOfDates}. No lifecycle status changed.`,
        }, svc);
      } else {
        await resolveIssue(edgeHealthKey("ic", market), svc);
      }
    }

    if (runId) {
      const evaluated = Object.values(results).reduce((s: number, r: any) => s + (r.icRowsEvaluated ?? 0), 0);
      const inserted = Object.values(results).reduce((s: number, r: any) => s + (r.icRowsInserted ?? 0), 0);
      await svc.from("agent_runs").update({
        status: "done", signals_written: inserted, completed_at: new Date().toISOString(),
        result_summary: `EdgeIC (measure-only): evaluated ${evaluated}; inserted ${inserted} immutable rows across ${markets.join("+")}.`,
      } as any).eq("id", runId);
    }

    return NextResponse.json({
      ok: true, measureOnly: true,
      note: "IC measures whether an edge's ranking predicts forward returns. status='shadow_eligible' is ADVISORY — it does NOT grant trade permission. Priored factors clear at t≈2; net-of-fee long-only alpha is the later P5 gate. Universe is a current-liquid snapshot (survivorship bias) until PIT membership is wired.",
      results,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    for (const market of markets) {
      await reportIssue({
        issueKey: edgeHealthKey("ic", market), severity: "warn", category: "cron",
        title: `EdgeIC ${market.toUpperCase()} failed`, detail: msg.slice(0, 500),
      }, svc);
    }
    if (runId) { try { await svc.from("agent_runs").update({ status: "error", result_summary: msg.slice(0, 500), completed_at: new Date().toISOString() } as any).eq("id", runId); } catch {} }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ message: "POST to run EdgeIC (owner or cron). Measure-only. Params: market, maxSymbols, maxDates, stepDays." });
}
