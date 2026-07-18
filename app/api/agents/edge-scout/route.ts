import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { verifyCronSecret } from "@/lib/auth/cron";
import { requireOwner } from "@/lib/auth/require-owner";
import { EDGES } from "@/lib/edges/registry";
import { computeEdges } from "@/lib/edges/compute";
import { liquidUniverse } from "@/lib/edges/universe";
import type { Market } from "@/lib/edges/types";
import { edgeHealthKey, inputFingerprint, provenanceMode, universeFingerprint } from "@/lib/edges/evidence";
import { reportIssue, resolveIssue } from "@/lib/system-health";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// EdgeScout — deterministic price/volume edge computation. MEASURE-ONLY (P0).
//
// HARD CONTRACT: writes ONLY to edge_* tables. Never touches agent_signals,
// paper_trades, paper_order_events, broker_orders, strategy_config, analyst_score,
// sizing, or any live-money path. No fundamentals. Bounded provider usage (maxSymbols
// cap + cached/budgeted candle fetchers). Idempotent (unique upserts). The P0
// universe is a CURRENT-liquid snapshot recorded in edge_universe_members — it is
// NOT point-in-time index membership, and this limitation is reported honestly.

const MAX_SYMBOLS_CAP = 200;
const DEFAULT_MAX_SYMBOLS = 40;
const MAX_DAYS_CAP = 20;

async function seedCatalog(svc: any) {
  const rows = EDGES.map(e => ({
    edge_id: e.id, name: e.name, category: e.category,
    formula_spec: null, inputs: [], rationale: e.rationale,
    expected_sign: e.expectedSign, horizon_days: e.horizonDays,
    data_source: e.dataSource, reference_urls: e.references, status: "candidate",
  }));
  // Insert missing definitions only. A daily scout must never reset lifecycle
  // state written by the evidence evaluator.
  const { error } = await svc.from("edge_catalog").upsert(rows, {
    onConflict: "edge_id", ignoreDuplicates: true,
  });
  if (error) throw new Error(`edge_catalog seed failed: ${error.message}`);
}

async function buildUniverse(svc: any, market: Market, maxSymbols: number, mode: string, offset: number): Promise<{ symbols: string[]; source: string }> {
  // Broad curated liquid universe (static, NON-PIT, survivorship-biased — labeled).
  // Paged by offset so it can be processed in bounded, cached slices across runs.
  if (mode === "liquid") {
    const all = liquidUniverse(market);
    return { symbols: all.slice(offset, offset + maxSymbols), source: `liquid_static[${offset}:${offset + maxSymbols}]` };
  }
  try {
    if (market === "us") {
      const nowIso = new Date().toISOString();
      const { data } = await svc.from("watchlist").select("symbol")
        .or(`expires_at.is.null,expires_at.gt.${nowIso}`).limit(maxSymbols * 3);
      const syms = [...new Set((data ?? []).map((r: any) => String(r.symbol ?? "").toUpperCase().trim()).filter(Boolean))].slice(0, maxSymbols);
      return { symbols: syms as string[], source: "watchlist" };
    }
    const { data } = await svc.from("india_screen_cache").select("symbol").not("symbol", "is", null).limit(maxSymbols * 4);
    const seen = new Set<string>();
    const syms: string[] = [];
    for (const r of (data ?? []) as any[]) {
      const raw = String(r.symbol ?? "").toUpperCase().trim();
      if (!raw) continue;
      const sym = raw.endsWith(".NS") || raw.endsWith(".BO") ? raw : `${raw}.NS`;
      if (seen.has(sym)) continue;
      seen.add(sym); syms.push(sym);
      if (syms.length >= maxSymbols) break;
    }
    return { symbols: syms, source: "india_screen_cache" };
  } catch (e: any) {
    return { symbols: [], source: `error:${e?.message ?? "universe"}` };
  }
}

function weekdaysBetween(from: string, to: string, cap: number): string[] {
  const out: string[] = [];
  const start = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  for (let d = start; d <= end && out.length < cap; d = new Date(d.getTime() + 86400_000)) {
    const dow = d.getUTCDay();
    if (dow >= 1 && dow <= 5) out.push(d.toISOString().slice(0, 10));
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
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const maxDays = Math.max(1, Math.min(MAX_DAYS_CAP, Number(url.searchParams.get("maxDays") ?? 5) || 5));
    const universeMode = url.searchParams.get("universe") === "liquid" ? "liquid" : "watchlist";
    const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
    const historyDays = url.searchParams.get("historyDays") ? Math.max(120, Math.min(1600, Number(url.searchParams.get("historyDays")))) : undefined;
    markets = marketParam === "us" ? ["us"] : marketParam === "india" ? ["india"] : ["us", "india"];

    const { data: runRow } = await svc.from("agent_runs").insert({
      agent_type: "edge_scout", status: "running",
      trigger_source: isCron ? "scheduled" : "manual",
      market: markets.length === 1 ? markets[0] : null,
    } as any).select().single();
    runId = (runRow as any)?.id ?? null;

    await seedCatalog(svc);

    const results: Record<string, any> = {};
    for (const market of markets) {
      const { symbols, source } = await buildUniverse(svc, market, maxSymbols, universeMode, offset);
      const runDate = new Date().toISOString().slice(0, 10);
      const universeId = `${market}:${universeMode}:${runDate}:${universeFingerprint(market, symbols)}`;

      if (symbols.length) {
        const memberRows = symbols.map(s => ({
          universe_id: universeId, market, symbol: s, as_of_date: runDate,
          source, included_reason: "p0_current_liquid_snapshot (NOT point-in-time membership)",
        }));
        await svc.from("edge_universe_members").upsert(memberRows, { onConflict: "universe_id,market,symbol" });
      }

      const asOfDates = (from && to) ? weekdaysBetween(from, to, maxDays) : undefined;
      const observedAt = new Date().toISOString();
      const provenance = provenanceMode(Boolean(asOfDates?.length));
      const { rows, report } = symbols.length
        ? await computeEdges({ market, symbols, asOfDates, maxDays, candleDays: historyDays })
        : { rows: [], report: { market, symbolsRequested: 0, symbolsResolved: 0, unavailable: [], sources: {}, benchmarkSource: "n/a", dates: [], rows: 0 } };

      let signalsWritten = 0, inputsWritten = 0;
      if (rows.length) {
        const sigRows = rows.map(r => {
          const fingerprint = inputFingerprint({
            market, symbol: r.symbol, date: r.date, edgeId: r.edgeId,
            source: `${r.source}|${universeId}|z=${r.z == null ? "null" : r.z.toPrecision(12)}`,
            rawValue: r.raw,
          });
          return {
            symbol: r.symbol, date: r.date, edge_id: r.edgeId, market: r.market,
            raw_value: r.raw, z_value: r.z, universe_id: universeId,
            observed_at: observedAt, provenance_mode: provenance,
            input_fingerprint: fingerprint,
          };
        });
        const { data: upserted, error: signalError } = await svc.from("edge_signals")
          .upsert(sigRows, {
            onConflict: "symbol,date,edge_id,market,input_fingerprint", ignoreDuplicates: true,
          }).select("id,symbol,date,edge_id,market,raw_value,input_fingerprint");
        if (signalError) throw new Error(`edge_signals write failed (${market}): ${signalError.message}`);
        signalsWritten = upserted?.length ?? 0;

        const srcByKey = new Map(rows.map(r => [`${r.symbol}|${r.date}|${r.edgeId}|${r.market}`, r.source]));
        const inputRows = (upserted ?? []).map((u: any) => {
          const src = srcByKey.get(`${u.symbol}|${u.date}|${u.edge_id}|${u.market}`) ?? "unknown";
          return {
            edge_signal_id: u.id, input_name: "daily_candles", source: src,
            as_of_date: u.date, available_at: observedAt, observed_at: observedAt,
            provenance_mode: provenance,
            input_fingerprint: inputFingerprint({
              market, symbol: u.symbol, date: u.date, edgeId: u.edge_id,
              source: src, rawValue: u.raw_value == null ? null : Number(u.raw_value),
            }),
            revised_at: null,
            adjustment_policy: "provider-reported basis; not independently verified",
            raw_ref: `${src}:${u.input_fingerprint}`,
          };
        });
        if (inputRows.length) {
          const { error: inputError } = await svc.from("edge_signal_inputs").upsert(inputRows, {
            onConflict: "edge_signal_id,input_name,source,as_of_date", ignoreDuplicates: true,
          });
          if (inputError) throw new Error(`edge input audit failed (${market}): ${inputError.message}`);
          inputsWritten = inputRows.length;
        }
      }

      results[market] = { universeId, universeSize: symbols.length, universeSource: source, signalsWritten, inputsWritten, providerReport: report };
      if (report.rows === 0) {
        await reportIssue({
          issueKey: edgeHealthKey("scout", market), severity: "warn", category: "data",
          title: `EdgeScout produced no ${market.toUpperCase()} evidence`,
          detail: `Universe=${symbols.length}; resolved=${report.symbolsResolved}; unavailable=${report.unavailable.length}. Measure-only collection is stale until a clean run.`,
        }, svc);
      } else {
        await resolveIssue(edgeHealthKey("scout", market), svc);
      }
    }

    if (runId) {
      const total = Object.values(results).reduce((s: number, r: any) => s + (r.signalsWritten ?? 0), 0);
      await svc.from("agent_runs").update({
        status: "done", signals_written: total, completed_at: new Date().toISOString(),
        result_summary: `EdgeScout (measure-only): ${total} edge_signals across ${markets.join("+")}.`,
      } as any).eq("id", runId);
    }

    return NextResponse.json({
      ok: true, measureOnly: true,
      universeLimitation: "P0 universe is a CURRENT-liquid snapshot recorded in edge_universe_members — NOT point-in-time index membership. IC/backtests built on it carry survivorship bias until PIT membership is wired (P1+).",
      results,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    for (const market of markets) {
      await reportIssue({
        issueKey: edgeHealthKey("scout", market), severity: "warn", category: "cron",
        title: `EdgeScout ${market.toUpperCase()} failed`, detail: msg.slice(0, 500),
      }, svc);
    }
    if (runId) {
      try { await svc.from("agent_runs").update({ status: "error", result_summary: msg.slice(0, 500), completed_at: new Date().toISOString() } as any).eq("id", runId); } catch {}
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ message: "POST to run EdgeScout (owner or cron). Measure-only. Params: market=us|india|both, maxSymbols, from, to, maxDays." });
}
