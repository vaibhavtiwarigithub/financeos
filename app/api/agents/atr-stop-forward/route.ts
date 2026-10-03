import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { benchmarkSymbolFor } from "@/lib/data/benchmark-registry";
import { fetchYahooRawReplaySeries, type YahooRawReplaySeries } from "@/lib/data/yahoo-candles";
import { readEntryAtr } from "@/lib/learning/atr-exit-evidence";
import { ATR_FORWARD_BLOCK_SESSIONS, ATR_FORWARD_PROGRAM_ID } from "@/lib/shadows/atr-forward-collector";
import { runAtrForwardCollection, type AtrForwardDeps } from "@/lib/shadows/atr-forward-run";
import { buildShadowBookAttribution } from "@/lib/shadows/shadow-book-attribution";
import { ATR_STOP_FORWARD_PROGRAM_VERSION } from "@/lib/shadows/atr-stop-forward-replay";
import { runWithProducerHealth } from "@/lib/shadows/producer-runs";
import { writeAttributionRow } from "@/lib/shadows/attribution-writer";
import { writeShadowBookSnapshot, type ShadowBookSnapshotRow } from "@/lib/shadows/shadow-book-ledger";
import { expectedLatestSessionDate, expectedMarketSessionsBetween } from "@/lib/trading/market-calendar";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/agents/atr-stop-forward?market=us
//
// Forward paired shadow book for the 2.8x-ATR stop challenger. It seeds an
// identical baseline/variant book from the reconciled US paper book, then each
// run advances both arms one completed session at a time from raw OHLC,
// validated corporate actions and the actual paper-lot entries/sales, and
// appends a snapshot per session. It reads the paper ledger and writes ONLY
// upgrade_path_shadow_book_runs and the producer-run health ledger: no order,
// score, stop, target, sizing or position path reads or is changed by it.
//
// US only. India has no corporate-action source (Massive does not cover NSE and
// Alpha Vantage's daily cap cannot certify a book), so its replay stays blocked.
async function authorize(req: NextRequest): Promise<NextResponse | null> {
  if (verifyCronSecret(req)) return null;
  return requireOwner();
}

const YAHOO_CONCURRENCY = 4;

async function loadRawSeries(symbols: string[]): Promise<Map<string, YahooRawReplaySeries | null>> {
  const unique = [...new Set(symbols.map((symbol) => symbol.toUpperCase()))];
  const out = new Map<string, YahooRawReplaySeries | null>();
  for (let i = 0; i < unique.length; i += YAHOO_CONCURRENCY) {
    const batch = unique.slice(i, i + YAHOO_CONCURRENCY);
    const fetched = await Promise.all(batch.map((symbol) => fetchYahooRawReplaySeries(symbol, "3mo")));
    batch.forEach((symbol, index) => out.set(symbol, fetched[index]));
  }
  return out;
}

function buildDeps(svc: any, now: Date): AtrForwardDeps {
  return {
    market: "us",
    now,
    expectedLatestSession: () => expectedLatestSessionDate("us", now).date,
    sessionsBetween: (after, through) => expectedMarketSessionsBetween("us", after, through),
    loadPriorRows: async () => fetchAllRows<ShadowBookSnapshotRow>((from, to) => svc
      .from("upgrade_path_shadow_book_runs").select("*")
      .eq("program_id", ATR_FORWARD_PROGRAM_ID).eq("market", "us").eq("program_version", ATR_STOP_FORWARD_PROGRAM_VERSION)
      .order("session_date", { ascending: true }).range(from, to), "ATR forward snapshots"),
    loadSeedSource: async () => {
      const [portfolio, positions, lots, marks] = await Promise.all([
        svc.from("paper_portfolio").select("cash_balance,nav,updated_at").eq("market", "us").maybeSingle(),
        svc.from("paper_positions")
          .select("symbol,market,position_role,qty,avg_cost,current_price,stop_loss,initial_stop_loss,price_target,highest_price")
          .eq("market", "us").is("exit_reason", null).gt("qty", 0).limit(500),
        svc.from("paper_trades")
          .select("symbol,market,position_role,qty,order_side,closed_at,partial_exit_lot")
          .eq("market", "us").eq("order_side", "buy").is("closed_at", null).limit(2000),
        // The marks paper NAV itself was computed from at the latest recorded session.
        svc.from("paper_position_marks").select("symbol,mark_price,session_date,recorded_at")
          .eq("market", "us").order("session_date", { ascending: false }).order("recorded_at", { ascending: false }).limit(200),
      ]);
      const failed = portfolio.error ?? positions.error ?? lots.error ?? marks.error;
      if (failed) throw new Error(`Seed source read failed: ${failed.message}`);
      const latestSession = (marks.data ?? [])[0]?.session_date ?? null;
      const paperMarks: Record<string, number> = {};
      for (const row of marks.data ?? []) {
        if (row.session_date !== latestSession) continue;
        const symbol = String(row.symbol).toUpperCase();
        if (paperMarks[symbol] == null) paperMarks[symbol] = Number(row.mark_price);
      }
      return {
        cashBalance: portfolio.data?.cash_balance ?? null,
        reportedNav: portfolio.data?.nav ?? null,
        marksUpdatedAt: portfolio.data?.updated_at ?? null,
        paperMarks,
        paperMarksSession: latestSession,
        positions: positions.data ?? [],
        openLots: lots.data ?? [],
      };
    },
    benchmarkSymbol: benchmarkSymbolFor("us", "portfolio"),
    loadRawSeries,
    loadLotRows: async (afterSession) => {
      const floor = new Date(`${afterSession}T00:00:00Z`);
      floor.setUTCDate(floor.getUTCDate() - 1);
      const since = floor.toISOString();
      return fetchAllRows((from, to) => svc
        .from("paper_trades")
        .select("id,market,symbol,order_side,qty,fill_price,executed_at,signal_id,paper_event_id,position_role,stop_loss,take_profit,exit_price,exit_reason,exit_at,closed_at,partial_exit_lot")
        .eq("market", "us").eq("order_side", "buy")
        .or(`executed_at.gte.${since},exit_at.gte.${since},closed_at.gte.${since}`)
        .order("id", { ascending: true }).range(from, to), "ATR forward paper lots");
    },
    loadAtrBySignal: async (signalIds) => {
      const rows = await fetchAllRows<{ signal_id: string; features: unknown }>((from, to) => svc
        .from("decision_observations").select("signal_id,features").in("signal_id", signalIds)
        .order("ts", { ascending: true }).range(from, to), "ATR decision observations");
      const out: Record<string, number | null> = {};
      for (const row of rows) out[row.signal_id] = out[row.signal_id] ?? readEntryAtr(row.features);
      return out;
    },
    loadActionLedger: async (symbols, fromSession, throughSession) => {
      if (!symbols.length) return [];
      const { data, error } = await svc.from("corporate_actions")
        .select("symbol,action_type,ex_date,split_ratio,dividend_amount")
        .in("symbol", symbols).gt("ex_date", fromSession).lte("ex_date", throughSession).limit(5000);
      if (error) throw new Error(`Corporate-action ledger read failed: ${error.message}`);
      return data ?? [];
    },
    loadCoverage: async (symbols) => {
      if (!symbols.length) return [];
      const { data, error } = await svc.from("corporate_action_source_coverage")
        .select("symbol,action_type,status,checked_at,provider_fetched_at,records_count")
        .in("symbol", symbols).order("checked_at", { ascending: false }).limit(5000);
      if (error) throw new Error(`Corporate-action coverage read failed: ${error.message}`);
      return data ?? [];
    },
    writeSnapshot: (row) => writeShadowBookSnapshot(svc, row),
  };
}

export async function POST(req: NextRequest) {
  const gate = await authorize(req);
  if (gate) return gate;
  const market = new URL(req.url).searchParams.get("market");
  if (market !== "us") {
    return NextResponse.json({
      error: "The forward ATR shadow book is US only; India has no corporate-action source and stays blocked.",
      persisted: false,
    }, { status: 400 });
  }

  const svc = createServiceClient();
  const now = new Date();
  try {
    return await runWithProducerHealth({
      client: svc,
      programId: ATR_FORWARD_PROGRAM_ID,
      market: "us",
      triggerSource: verifyCronSecret(req) ? "cron_authenticated" : "owner_manual",
      codeVersion: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      work: async () => {
        const result = await runAtrForwardCollection(buildDeps(svc, now));
        const snapshots = await fetchAllRows<ShadowBookSnapshotRow>((from, to) => svc
          .from("upgrade_path_shadow_book_runs").select("*")
          .eq("program_id", ATR_FORWARD_PROGRAM_ID).eq("market", "us")
          .eq("program_version", ATR_STOP_FORWARD_PROGRAM_VERSION)
          .order("session_date", { ascending: true }).range(from, to), "ATR paired-book attribution source");
        // Derived attribution must never mask the collection that already succeeded: a refusal here (for example a
        // corrupted history) used to throw, turning a written snapshot into a failed producer run with no detail.
        let attribution: ReturnType<typeof buildShadowBookAttribution>;
        let attributionRefusal: string | null = null;
        try {
          attribution = buildShadowBookAttribution(snapshots, ATR_FORWARD_BLOCK_SESSIONS);
        } catch (error) {
          attributionRefusal = error instanceof Error ? error.message : String(error);
          attribution = { state: "collecting", reason: `Attribution refused: ${attributionRefusal}`, asOfSession: result.observedSession, independentBlocks: 0 };
        }
        let attributionWrite: "inserted" | "already_present" | "collecting" = "collecting";
        if (attribution.state === "measured") {
          attributionWrite = await writeAttributionRow(svc, attribution.row);
        }
        const attributionPersisted = attribution.state === "measured" && attributionWrite === "inserted";
        const attributionSummary = attribution.state === "measured"
          ? {
            state: "measured" as const, returnBasis: "net_only" as const, write: attributionWrite,
            asOfSession: attribution.row.as_of_session, independentBlocks: attribution.independentBlocks,
            netDeltaPct: attribution.row.net_incremental_return_pct,
            intervalPct: [attribution.row.ci_lower_pct, attribution.row.ci_upper_pct],
            tStatistic: attribution.row.t_statistic,
            discardedTrailingSessions: attribution.discardedTrailingSessions,
          }
          : { state: "collecting" as const, reason: attribution.reason, asOfSession: attribution.asOfSession, independentBlocks: attribution.independentBlocks };
        return {
          value: NextResponse.json({ ...result, persisted: result.written.length > 0 || attributionPersisted, attribution: attributionSummary }, { status: 200 }),
          outcome: {
            status: result.status,
            expectedSession: result.expectedSession,
            observedSession: result.observedSession,
            blockers: attributionRefusal ? [...result.blockers, `Attribution refused: ${attributionRefusal}`] : result.blockers,
            details: {
              evidenceType: "forward_paired_book_snapshot",
              written: result.written,
              ...result.details,
              performanceAttribution: attributionSummary,
            },
          },
        };
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "ATR forward collection failed";
    return NextResponse.json({ error: message, persisted: false }, { status: 500 });
  }
}
