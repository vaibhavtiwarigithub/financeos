import { providerCachedFetch } from "@/lib/data/provider-fetch";
import { createServiceClient } from "@/lib/supabase/service";
import { isRealIsoDate, normalizeRealIsoDate } from "@/lib/date-only";

// Point-in-time earnings DATA CAPTURE (features/known-anomalies §3, build steps
// 2 & 3). This is the enabler for a FUTURE PEAD / revision-momentum feature — it
// is *capture only*. Nothing here scores, sizes, gates, orders, or exits, and no
// money-path code reads what it writes. Fully deterministic; no LLM.
//
// Two things get captured on the earnings-refresh cadence:
//
//   1. First-observed provider actual EPS/revenue (+ announcement session) — stored on the
//      earnings_calendar row in the immutable `eps_actual_first` field. Once set it
//      is NEVER overwritten; a later differing print is a correction and lands in
//      `restated_eps` instead. `actual_available_at` records when WE could first
//      know the value (point-in-time).
//
//   2. Pre-announcement consensus vintages — appended to
//      earnings_consensus_snapshots while the report is still upcoming, so we begin
//      accumulating the "last valid consensus strictly before announcement" that a
//      PEAD surprise numerator needs.
//
// Source: Finnhub earnings calendar (free, 60/min, no daily cap, already the wired
// US earnings source in lib/data/earnings.ts). Its `hour` field gives the
// announcement session; `epsActual`/`revenueActual` are null until the print, and
// non-null afterward. FinancialDatasets/Webull are metered/MCP-only and give a
// current snapshot, not a durable pre-announcement vintage — Finnhub is the free
// HTTP fit for a Vercel cron.

const FINNHUB_BASE = "https://finnhub.io/api/v1";
const US_MARKET_TZ = "America/New_York";

// Finnhub `hour` → canonical announcement session (matches the DB check constraint).
function mapSession(hour: unknown): "before_open" | "during_session" | "after_close" | "unknown" {
  const h = String(hour ?? "").toLowerCase();
  if (h === "bmo") return "before_open";
  if (h === "amc") return "after_close";
  if (h === "dmh") return "during_session";
  return "unknown";
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dateInTimeZone(d: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

// Conservative PIT rule: without an exact announcement timestamp, never capture
// a consensus on the report's US-market calendar date. This prevents a delayed
// actual from making a post-announcement estimate look pre-announcement later.
export function isStrictlyPreAnnouncementVintage(
  availableAt: string | Date,
  reportDate: string,
): boolean {
  if (!isRealIsoDate(reportDate)) return false;
  const d = availableAt instanceof Date ? availableAt : new Date(availableAt);
  if (!Number.isFinite(d.getTime())) return false;
  return dateInTimeZone(d, US_MARKET_TZ) < reportDate;
}

// Small tolerance so provider float noise on an unchanged print is NOT logged as a
// "restatement". A genuine correction moves EPS by far more than a cent.
const RESTATE_EPS_EPSILON = 0.005;

interface FinnhubEarnRow {
  symbol?: string;
  date?: string;
  epsActual?: number | null;
  epsEstimate?: number | null;
  revenueActual?: number | null;
  revenueEstimate?: number | null;
  hour?: string;
  quarter?: number;
  year?: number;
}

export interface EarningsPitResult {
  symbolsProcessed: number;
  actualsCaptured: number;    // first-reported actuals newly stored
  correctionsLogged: number;  // later differing prints stored as restatements
  consensusSnapshots: number; // pre-announcement vintages appended
  skipped: number;
  errors: number;
}

// Capture PIT earnings data for a set of symbols on one market. Called from the
// earnings-refresh route (the existing cadence). Fail-soft per symbol so one bad
// provider response never aborts the batch.
export async function captureEarningsPit(
  symbols: string[],
  market: "us" | "india" = "us",
  opts: { lookbackDays?: number; lookaheadDays?: number } = {},
): Promise<EarningsPitResult> {
  const res: EarningsPitResult = {
    symbolsProcessed: 0, actualsCaptured: 0, correctionsLogged: 0,
    consensusSnapshots: 0, skipped: 0, errors: 0,
  };

  // India earnings actuals are NOT trivially available on a free durable source;
  // per-market policy forbids assuming parity. Only US is wired here.
  if (market !== "us") return res;

  const key = process.env.FINNHUB_API_KEY ?? "";
  if (!key) return res;

  const svc = createServiceClient();
  const now = new Date();
  const from = fmtDate(new Date(now.getTime() - (opts.lookbackDays ?? 120) * 86400000));
  const to = fmtDate(new Date(now.getTime() + (opts.lookaheadDays ?? 120) * 86400000));

  for (const rawSym of symbols) {
    const symbol = rawSym.trim().toUpperCase();
    if (!symbol) continue;
    res.symbolsProcessed++;
    try {
      const url = `${FINNHUB_BASE}/calendar/earnings?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}&token=${key}`;
      const json = await providerCachedFetch("finnhub", `FINNHUB_EARN_PIT:${symbol}:${from}:${to}`, url, {
        timeoutMs: 8000,
        isThrottled: (j) => !j?.earningsCalendar,
      });
      const rows: FinnhubEarnRow[] = json?.earningsCalendar ?? [];
      if (!Array.isArray(rows) || rows.length === 0) { res.skipped++; continue; }

      for (const row of rows) {
        const reportDate = normalizeRealIsoDate(row.date);
        if (!reportDate) continue;
        const fiscalPeriod = row.year != null && row.quarter != null
          ? `${row.year}Q${row.quarter}` : null;
        const hasActual = typeof row.epsActual === "number" && Number.isFinite(row.epsActual);

        if (hasActual) {
          await captureActual(svc, symbol, market, reportDate, row, res);
        } else if (
          typeof row.epsEstimate === "number" &&
          Number.isFinite(row.epsEstimate) &&
          isStrictlyPreAnnouncementVintage(now, reportDate)
        ) {
          // Upcoming report → snapshot the consensus as a pre-announcement vintage.
          await snapshotConsensus(svc, symbol, market, reportDate, fiscalPeriod, row, res);
        }
      }
    } catch {
      res.errors++;
    }
  }
  return res;
}

// Store the FIRST-reported actual immutably; log a later differing print as a
// correction without ever touching the first value.
async function captureActual(
  svc: ReturnType<typeof createServiceClient>,
  symbol: string,
  market: "us" | "india",
  reportDate: string,
  row: FinnhubEarnRow,
  res: EarningsPitResult,
): Promise<void> {
  const nowIso = new Date().toISOString();
  const epsActual = row.epsActual as number;
  const revActual = typeof row.revenueActual === "number" && Number.isFinite(row.revenueActual)
    ? Math.round(row.revenueActual) : null;
  const session = mapSession(row.hour);

  // Look up the existing row (upserted by the estimates path on symbol,report_date).
  const { data: existing, error: existingError } = await svc
    .from("earnings_calendar")
    .select("id, eps_actual_first")
    .eq("symbol", symbol)
    .eq("report_date", reportDate)
    .maybeSingle();
  if (existingError) throw new Error("earnings_actual_lookup_failed");

  if (existing && (existing as { eps_actual_first: number | null }).eps_actual_first != null) {
    // Immutable first-reported actual already present. A materially different value
    // now is a correction/restatement → store separately, never overwrite.
    const first = Number((existing as { eps_actual_first: number }).eps_actual_first);
    if (Math.abs(first - epsActual) > RESTATE_EPS_EPSILON) {
      const { data: changed, error } = await svc
        .from("earnings_calendar")
        .update({
          restated_eps: epsActual,
          restated_available_at: nowIso,
          restated_source: "finnhub",
        })
        .eq("id", (existing as { id: string }).id)
        // Only write if we haven't already logged this same correction (idempotent).
        .or(`restated_eps.is.null,restated_eps.neq.${epsActual}`)
        .select("id");
      if (error) throw new Error("earnings_restatement_write_failed");
      if ((changed ?? []).length > 0) res.correctionsLogged++;
    }
    return;
  }

  const actualFields = {
    eps_actual_first: epsActual,
    revenue_actual_first: revActual,
    actual_available_at: nowIso,
    announcement_session: session,
    // Finnhub's free calendar does not identify GAAP versus adjusted EPS.
    // Provider identity is not an accounting basis, so keep this unknown.
    eps_basis: null,
    actual_currency: "USD",
    actual_source: "finnhub",
    // Legacy display columns (read by GET /api/calendar/earnings). Set once here so
    // the calendar UI shows actuals; the immutable copy is eps_actual_first.
    eps_actual: epsActual,
    revenue_actual: revActual,
    fiscal_quarter: row.quarter != null ? String(row.quarter) : null,
    fiscal_year: row.year ?? null,
  };

  if (existing) {
    const { data: changed, error } = await svc
      .from("earnings_calendar")
      .update(actualFields)
      .eq("id", (existing as { id: string }).id)
      // Guard against a race: only fill if still empty (never overwrite a first).
      .is("eps_actual_first", null)
      .select("id");
    if (error) throw new Error("earnings_actual_write_failed");
    if ((changed ?? []).length > 0) res.actualsCaptured++;
  } else {
    // Event not in the table (never had an estimate row) — insert, but never use
    // an upsert that could overwrite a concurrent first-observed actual.
    const { data: inserted, error } = await svc
      .from("earnings_calendar")
      .insert({
        symbol,
        market,
        report_date: reportDate,
        report_time: row.hour === "bmo" ? "am" : row.hour === "amc" ? "pm" : null,
        eps_estimate: typeof row.epsEstimate === "number" ? row.epsEstimate : null,
        revenue_estimate: typeof row.revenueEstimate === "number" ? Math.round(row.revenueEstimate) : null,
        fetched_at: nowIso,
        ...actualFields,
      })
      .select("id");
    if (error) throw new Error("earnings_actual_insert_failed");
    if ((inserted ?? []).length > 0) res.actualsCaptured++;
  }
}

// Append a pre-announcement consensus vintage — but only when it adds information:
// skip if the latest snapshot for this (symbol, report_date) already holds the same
// consensus, so the append-only log grows with real revisions, not identical dupes.
async function snapshotConsensus(
  svc: ReturnType<typeof createServiceClient>,
  symbol: string,
  market: "us" | "india",
  reportDate: string,
  fiscalPeriod: string | null,
  row: FinnhubEarnRow,
  res: EarningsPitResult,
): Promise<void> {
  const consensus = row.epsEstimate as number;

  const { data: latest, error: latestError } = await svc
    .from("earnings_consensus_snapshots")
    .select("consensus_eps")
    .eq("symbol", symbol)
    .eq("market", market)
    .eq("report_date", reportDate)
    .order("snapshot_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestError) throw new Error("earnings_consensus_lookup_failed");

  if (latest && Number((latest as { consensus_eps: number }).consensus_eps) === consensus) {
    return; // no revision since last vintage — nothing to add
  }

  const nowIso = new Date().toISOString();
  const { error } = await svc
    .from("earnings_consensus_snapshots")
    .insert({
      symbol,
      market,
      report_date: reportDate,
      fiscal_period: fiscalPeriod,
      consensus_eps: consensus,
      analyst_count: null, // Finnhub free calendar does not expose a contributor count
      // Provider identity does not prove GAAP/adjusted comparability.
      basis: null,
      currency: "USD",
      source: "finnhub",
      snapshot_at: nowIso,
      available_at: nowIso,
    });
  if (error) throw new Error("earnings_consensus_insert_failed");
  res.consensusSnapshots++;
}
