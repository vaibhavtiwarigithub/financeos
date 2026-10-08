import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { candidateRowForFiling, LISTING_DISCOVERY_POLICY, selectUnambiguousIdentityForCik, stateAfterVerifiedFirstTrade } from "@/lib/listings/discovery";
import { collectEdgarIndexes, fetchSecCurrentIssuerListings, type EdgarListingFiling, type SecCurrentIssuerListing } from "@/lib/listings/sec-edgar";
import { createServiceClient } from "@/lib/supabase/service";
import { reportIssue, resolveIssue } from "@/lib/system-health";
import { fetchAllRows } from "@/lib/supabase/paginate";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function ownerOrCron(req: NextRequest) { return verifyCronSecret(req) ? null : requireOwner(); }

async function persistFiling(svc: any, filing: EdgarListingFiling) {
  const now = new Date();
  const candidate = candidateRowForFiling(filing, now);
  const { data: existing, error: existingError } = await svc.from("listing_candidates")
    .select("id,state,first_seen_at").eq("market", "us").eq("listing_key", candidate.listing_key).maybeSingle();
  if (existingError) throw new Error(`candidate read failed: ${existingError.message}`);

  let candidateId = existing?.id as number | undefined;
  const eventState = candidate.state;
  if (!candidateId) {
    const { data, error } = await svc.from("listing_candidates").insert({ ...candidate, instrument_type: "unknown", first_seen_at: now.toISOString() }).select("id").single();
    if (error) throw new Error(`candidate insert failed: ${error.message}`);
    candidateId = data.id;
  } else {
    // Never downgrade an observed listing, withdrawal, or rejection merely
    // because an older filing is re-read by an overlapping daily window.
    const terminalOrAdvanced = ["listed_observing", "withdrawn", "postponed", "rejected", "delisted", "paper_admitted"].includes(existing.state);
    const { error } = await svc.from("listing_candidates").update({
      ...candidate,
      state: terminalOrAdvanced ? existing.state : eventState,
      first_seen_at: existing.first_seen_at,
    }).eq("id", candidateId);
    if (error) throw new Error(`candidate update failed: ${error.message}`);
  }

  const filingRow = {
    candidate_id: candidateId, cik: filing.cik, accession_number: filing.accessionNumber, form: filing.form,
    filed_at: filing.filedAt, primary_document_url: filing.sourceUrl, issuer_name: filing.companyName,
    document_hash: filing.payloadHash, parser_version: LISTING_DISCOVERY_POLICY, quality_state: "metadata_only",
    structured_payload: { source: "sec_edgar_daily_index", accession_number: filing.accessionNumber },
  };
  const { error: filingError } = await svc.from("issuer_filings").upsert(filingRow, { onConflict: "accession_number,document_hash", ignoreDuplicates: true });
  if (filingError) throw new Error(`filing write failed: ${filingError.message}`);

  const event = {
    candidate_id: candidateId, event_type: "filing_discovered", event_at: now.toISOString(), effective_at: `${filing.filedAt}T00:00:00.000Z`,
    prior_state: existing?.state ?? null, next_state: eventState, source: "sec_edgar_daily_index", source_event_id: filing.accessionNumber,
    source_url: filing.sourceUrl, source_payload_hash: filing.payloadHash, reason_code: "sec_registration_filing",
    calculations: { form: filing.form, evidence_only: true }, code_version: LISTING_DISCOVERY_POLICY,
  };
  const { error: eventError } = await svc.from("listing_candidate_events").upsert(event, {
    onConflict: "candidate_id,event_type,source,source_event_id,source_payload_hash", ignoreDuplicates: true,
  });
  if (eventError) throw new Error(`candidate event write failed: ${eventError.message}`);
  return { created: !existing, candidateId };
}

const VERIFIED_SPCX_LISTING = {
  market: "us", issuer_key: "0001181412", listing_key: "sec-cik:0001181412", symbol: "SPCX",
  company_name: "Space Exploration Technologies Corp.", exchange: "Nasdaq", instrument_type: "operating_company",
  state: "listed_observing", first_trade_date: "2026-06-12", source: "nasdaq_dtn_and_sec_issuer_release",
  source_event_id: "DTN2026-8", source_url: "https://www.nasdaqtrader.com/TraderNews.aspx?id=DTN2026-8",
  corroborating_url: "https://www.sec.gov/Archives/edgar/data/1181412/000162828026052515/earningsreleaseq22608042.htm",
};

/** A narrowly scoped, source-verified backfill for the listing missed before the event collector existed. */
async function persistVerifiedListing(svc: any) {
  const now = new Date().toISOString();
  const payloadHash = createHash("sha256").update(JSON.stringify(VERIFIED_SPCX_LISTING)).digest("hex");
  const { corroborating_url, ...candidateEvidence } = VERIFIED_SPCX_LISTING;
  const { data: existing, error: readError } = await svc.from("listing_candidates").select("id,state,first_seen_at")
    .eq("market", "us").eq("listing_key", VERIFIED_SPCX_LISTING.listing_key).maybeSingle();
  if (readError) throw new Error(`verified listing read failed: ${readError.message}`);
  const row = { ...candidateEvidence, source_payload_hash: payloadHash, last_seen_at: now, updated_at: now,
    first_seen_at: existing?.first_seen_at ?? now };
  const nextState = stateAfterVerifiedFirstTrade(existing?.state);
  let candidateId = existing?.id as number | undefined;
  if (candidateId) {
    const { error } = await svc.from("listing_candidates").update({ ...row, state: nextState }).eq("id", candidateId);
    if (error) throw new Error(`verified listing update failed: ${error.message}`);
  } else {
    const { data, error } = await svc.from("listing_candidates").insert(row).select("id").single();
    if (error) throw new Error(`verified listing insert failed: ${error.message}`);
    candidateId = data.id;
  }
  const event = {
    candidate_id: candidateId, event_type: "listing_observed", event_at: now,
    effective_at: `${VERIFIED_SPCX_LISTING.first_trade_date}T00:00:00.000Z`, prior_state: existing?.state ?? null,
    next_state: nextState, source: VERIFIED_SPCX_LISTING.source, source_event_id: VERIFIED_SPCX_LISTING.source_event_id,
    source_url: VERIFIED_SPCX_LISTING.source_url, source_payload_hash: payloadHash, reason_code: "exchange_confirmed_first_trade",
    calculations: { first_trade_date: VERIFIED_SPCX_LISTING.first_trade_date, corroborating_url,
      evidence_only: true, research_enabled: false, paper_eligible: false }, code_version: LISTING_DISCOVERY_POLICY,
  };
  const { error } = await svc.from("listing_candidate_events").upsert(event, {
    onConflict: "candidate_id,event_type,source,source_event_id,source_payload_hash", ignoreDuplicates: true,
  });
  if (error) throw new Error(`verified listing event write failed: ${error.message}`);
  return { created: !existing, candidateId };
}

async function resolveCurrentIssuerSymbols(svc: any, identities: SecCurrentIssuerListing[]) {
  const candidates = await fetchAllRows<any>((from, to) => svc.from("listing_candidates")
    .select("id,issuer_key,state,symbol").eq("market", "us").is("symbol", null)
    .order("id", { ascending: true }).range(from, to), "unresolved US listing candidates");
  let resolved = 0;
  let ambiguous = 0;
  for (const candidate of candidates) {
    const resolvedIdentity = selectUnambiguousIdentityForCik(identities, String(candidate.issuer_key));
    if (resolvedIdentity.ambiguous) { ambiguous++; continue; } // Multiple share classes/listings: fail closed, never pick a ticker.
    const identity = resolvedIdentity.identity;
    if (!identity) continue; // Pre-listing issuer without an SEC current ticker is expected.
    const payloadHash = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
    const now = new Date().toISOString();
    const { error } = await svc.from("listing_candidates").update({ symbol: identity.symbol, company_name: identity.companyName,
      exchange: identity.exchange, last_seen_at: now, updated_at: now }).eq("id", candidate.id).is("symbol", null);
    if (error) throw new Error(`listing identity update failed: ${error.message}`);
    // This records ticker identity only. It deliberately leaves state and
    // first_trade_date untouched; the SEC ticker map is not an event feed.
    const event = { candidate_id: candidate.id, event_type: "state_transition", event_at: now,
      prior_state: candidate.state, next_state: candidate.state, source: "sec_company_tickers_exchange",
      source_event_id: `${identity.cik}:${identity.symbol}:${identity.exchange}`,
      source_url: "https://www.sec.gov/files/company_tickers_exchange.json", source_payload_hash: payloadHash,
      reason_code: "issuer_ticker_identity_resolved", calculations: { symbol: identity.symbol, exchange: identity.exchange,
        first_trade_verified: false, state_unchanged: true }, code_version: LISTING_DISCOVERY_POLICY };
    const { error: eventError } = await svc.from("listing_candidate_events").upsert(event, {
      onConflict: "candidate_id,event_type,source,source_event_id,source_payload_hash", ignoreDuplicates: true,
    });
    if (eventError) throw new Error(`listing identity evidence write failed: ${eventError.message}`);
    resolved++;
  }
  return { unresolved_before: candidates.length, identities_resolved: resolved, ambiguous_ciks: ambiguous,
    still_unresolved: candidates.length - resolved };
}

async function runDiscovery() {
  const svc = createServiceClient();
  const startedAt = new Date().toISOString();
  const fetched = await collectEdgarIndexes();
  const byAccession = new Map<string, EdgarListingFiling>();
  for (const batch of fetched) for (const filing of batch.filings) byAccession.set(filing.accessionNumber, filing);
  let created = 0;
  for (const filing of byAccession.values()) if ((await persistFiling(svc, filing)).created) created++;
  const identities = await fetchSecCurrentIssuerListings();
  const identityResolution = await resolveCurrentIssuerSymbols(svc, identities);
  // Nasdaq confirmed actual first trade; SpaceX's IPO was missed by the short
  // SEC daily-index window. Keep this correction in the candidate registry,
  // never the owner watchlist or any scoring/trading input.
  const spacex = await persistVerifiedListing(svc);
  const available = fetched.filter(x => x.status === "available").length;
  const status = available === fetched.length ? "completed" : available > 0 ? "partial" : "error";
  const summary = { policy: LISTING_DISCOVERY_POLICY, source: "sec_edgar_daily_index", status,
    dates: fetched.map(x => x.date), indexes: fetched.map(({ filings, ...index }) => ({ ...index, filing_count: index.status === "available" ? filings.length : null })),
    filings_seen: byAccession.size, candidates_created: created, verified_historical_listings_seeded: spacex.created ? 1 : 0,
    identity_map_source: "sec_company_tickers_exchange", identity_map_rows: identities.length, identity_resolution: identityResolution,
    identity_resolution_note: "unresolved SEC CIKs may be legitimate pre-listing issuers; current ticker mapping does not establish first trade",
    influence: "none" };
  // agent_runs is operational health only; it is not used as listing evidence.
  const { error: runError } = await svc.from("agent_runs").insert({ agent_type: "listing_discovery", market: "us", status, started_at: startedAt, completed_at: new Date().toISOString(), result_summary: JSON.stringify(summary), symbols: [] });
  if (runError) throw new Error(`listing discovery run recording failed: ${runError.message}`);
  if (status === "completed") await resolveIssue("listing-discovery:us", svc);
  else await reportIssue({ issueKey: "listing-discovery:us", severity: "warn", category: "data",
    title: "SEC filing discovery has unavailable indexes",
    detail: fetched.filter(x => x.status === "unavailable").map(x => `${x.date}: ${x.error}`).join("; ") }, svc);
  return summary;
}

export async function POST(req: NextRequest) {
  const gate = await ownerOrCron(req); if (gate) return gate;
  if (req.nextUrl.searchParams.get("market") !== "us") return NextResponse.json({ error: "only US evidence-only discovery is available" }, { status: 400 });
  try { const result = await runDiscovery(); return NextResponse.json(result, { status: result.status === "error" ? 502 : 200 }); }
  catch (error) {
    const message = error instanceof Error ? error.message : "listing discovery failed";
    // An unavailable regulator source must be visible as an errored run; no row
    // would make a dashboard interpret the absence as an empty listing day.
    await createServiceClient().from("agent_runs").insert({ agent_type: "listing_discovery", market: "us", status: "error", started_at: new Date().toISOString(), completed_at: new Date().toISOString(), result_summary: JSON.stringify({ source: "sec_edgar_daily_index", error: message, influence: "none" }), symbols: [] });
    return NextResponse.json({ error: message, influence: "none" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const gate = await requireOwner(); if (gate) return gate;
  const svc = createServiceClient();
  const { data, error } = await svc.from("listing_candidates").select("id,state,last_seen_at").eq("market", "us").order("last_seen_at", { ascending: false }).limit(1);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ policy: LISTING_DISCOVERY_POLICY, latest_candidate: data?.[0] ?? null, influence: "none" });
}
