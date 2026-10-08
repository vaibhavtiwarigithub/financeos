import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { candidateRowForFiling, LISTING_DISCOVERY_POLICY, selectUnambiguousIdentityForCik, stateAfterVerifiedFirstTrade } from "@/lib/listings/discovery";
import { collectEdgarIndexes, fetchSecCurrentIssuerListings, type EdgarListingFiling, type SecCurrentIssuerListing } from "@/lib/listings/sec-edgar";
import { createServiceClient } from "@/lib/supabase/service";
import { reportIssue, resolveIssue } from "@/lib/system-health";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { fetchUsSymbolDirectory, US_SYMBOL_DIRECTORY_SOURCE, type DirectoryCandidate } from "@/lib/listings/us-symbol-directory";

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

async function observeUsDirectoryDelta(svc: any, directory: Awaited<ReturnType<typeof fetchUsSymbolDirectory>>) {
  const { data: snapshot, error: snapshotError } = await svc.from("us_symbol_directory_snapshot")
    .select("listing_keys,source_as_of,source_hash").eq("id", "us").maybeSingle();
  if (snapshotError) throw new Error(`US symbol directory snapshot read failed: ${snapshotError.message}`);

  if (!snapshot) {
    const observedAt = new Date().toISOString();
    const { error } = await svc.from("us_symbol_directory_snapshot").upsert({ id: "us", listing_keys: directory.listingKeys,
      source_as_of: directory.sourceAsOf, source_hash: directory.sourceHash, observed_at: observedAt, updated_at: observedAt });
    if (error) throw new Error(`US symbol directory baseline write failed: ${error.message}`);
    return { status: "baseline" as const, as_of: directory.sourceAsOf, rows: directory.totalRows,
      researchable_rows: directory.researchable.length, excluded_rows: directory.excludedRows, additions: 0, candidates_observed: 0,
      source_hash: directory.sourceHash, note: "First valid directory snapshot is baseline only; existing market symbols were not labeled new." };
  }

  if (String(snapshot.source_as_of) > directory.sourceAsOf) throw new Error("US symbol directory source date moved backwards; prior snapshot was preserved");
  const prior = new Set((snapshot.listing_keys as string[] | null) ?? []);
  const added = directory.researchable.filter(row => !prior.has(row.listingKey));
  let candidatesObserved = 0;
  const chunkSize = 75;
  for (let offset = 0; offset < added.length; offset += chunkSize) {
    const batch = added.slice(offset, offset + chunkSize);
    const symbols = [...new Set(batch.map(row => row.symbol))];
    const existing = await fetchAllRows<any>((from, to) => svc.from("listing_candidates")
      .select("id,symbol,listing_key,state,first_seen_at").eq("market", "us").in("symbol", symbols).range(from, to),
    "existing US listing identities");
    const bySymbol = new Map<string, any[]>();
    for (const row of existing) {
      const key = String(row.symbol ?? "").toUpperCase();
      bySymbol.set(key, [...(bySymbol.get(key) ?? []), row]);
    }

    const exactKeys = new Set(existing.map((row: any) => String(row.listing_key)));
    const newRows = batch.filter(row => !exactKeys.has(`exchange-directory:${row.exchangeCode}:${row.symbol}`)).map(row => ({
      market: "us", issuer_key: `exchange-directory:${row.exchangeCode}:${row.symbol}`,
      listing_key: `exchange-directory:${row.exchangeCode}:${row.symbol}`, symbol: row.symbol, company_name: row.companyName,
      exchange: row.exchange, instrument_type: row.instrumentType, state: "directory_observed",
      first_trade_date: null, source: US_SYMBOL_DIRECTORY_SOURCE, source_event_id: `${directory.sourceAsOf}:${row.listingKey}`,
      source_url: row.exchangeCode === "Q" ? "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt" : "https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt",
      source_payload_hash: row.payloadHash, first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
    }));
    if (newRows.length) {
      const { error } = await svc.from("listing_candidates").upsert(newRows, { onConflict: "market,listing_key", ignoreDuplicates: true });
      if (error) throw new Error(`US directory candidate insert failed: ${error.message}`);
    }
    const keys = batch.map(row => `exchange-directory:${row.exchangeCode}:${row.symbol}`);
    const keyed = await fetchAllRows<any>((from, to) => svc.from("listing_candidates")
      .select("id,listing_key,state,first_seen_at").eq("market", "us").in("listing_key", keys).range(from, to),
    "US directory candidate IDs");
    const byListingKey = new Map(keyed.map((row: any) => [String(row.listing_key), row]));
    const now = new Date().toISOString();
    const events: any[] = [];
    const transitions: Array<{ id: number; state: string }> = [];
    for (const row of batch) {
      const listingKey = `exchange-directory:${row.exchangeCode}:${row.symbol}`;
      const exact = byListingKey.get(listingKey);
      const symbolMatches = bySymbol.get(row.symbol) ?? [];
      // If a SEC/other feed already identifies this exact ticker unambiguously,
      // keep its canonical candidate and attach an independent directory event.
      const target = exact ?? (symbolMatches.length === 1 && !String(symbolMatches[0].listing_key).startsWith("exchange-directory:")
        ? symbolMatches[0] : null);
      if (!target) {
        throw new Error(`US directory candidate could not be resolved for ${row.symbol}; snapshot not advanced`);
      }
      const id = Number(target.id);
      const nextState = target.state === "pre_listing" || target.state === "announced" ? "directory_observed" : target.state;
      if (nextState !== target.state) transitions.push({ id, state: nextState });
      events.push({ candidate_id: id, event_type: "listing_observed", event_at: now, effective_at: null,
        prior_state: target.state, next_state: target.state === "pre_listing" || target.state === "announced" ? "directory_observed" : target.state,
        source: US_SYMBOL_DIRECTORY_SOURCE, source_event_id: `${directory.sourceAsOf}:${row.listingKey}:${row.payloadHash}`,
        source_url: row.exchangeCode === "Q" ? "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt" : "https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt",
        source_payload_hash: row.payloadHash, reason_code: "active_directory_member_first_observed",
        calculations: { directory_as_of: directory.sourceAsOf, first_trade_date_verified: false,
          broker_support_verified: false, entry_eligible: false, instrument_type: row.instrumentType }, code_version: LISTING_DISCOVERY_POLICY });
      candidatesObserved++;
    }
    const { error: eventError } = await svc.from("listing_candidate_events").upsert(events, {
      onConflict: "candidate_id,event_type,source,source_event_id,source_payload_hash", ignoreDuplicates: true,
    });
    if (eventError) throw new Error(`US directory evidence events failed: ${eventError.message}`);
    // Persist the append-only transition event before mutable current state. If
    // this update fails, a retry can replay the idempotent event and finish it.
    for (const transition of transitions) {
      const { error } = await svc.from("listing_candidates").update({ state: transition.state,
        last_seen_at: now, updated_at: now }).eq("id", transition.id);
      if (error) throw new Error(`US directory state update failed: ${error.message}`);
    }
  }

  // Advance the baseline only after every new symbol and idempotent event is
  // persisted. Any earlier failure leaves the old snapshot for safe replay.
  const observedAt = new Date().toISOString();
  const { error: writeError } = await svc.from("us_symbol_directory_snapshot").upsert({ id: "us",
    listing_keys: directory.listingKeys, source_as_of: directory.sourceAsOf, source_hash: directory.sourceHash,
    observed_at: observedAt, updated_at: observedAt });
  if (writeError) throw new Error(`US symbol directory snapshot update failed: ${writeError.message}`);
  return { status: added.length ? "complete" as const : "unchanged" as const, as_of: directory.sourceAsOf,
    rows: directory.totalRows, researchable_rows: directory.researchable.length, excluded_rows: directory.excludedRows,
    additions: added.length, candidates_observed: candidatesObserved, source_hash: directory.sourceHash };
}

async function runDiscovery() {
  const svc = createServiceClient();
  const startedAt = new Date().toISOString();
  const [fetched, identityFetch, directoryFetch] = await Promise.all([
    collectEdgarIndexes(),
    fetchSecCurrentIssuerListings().then(identities => ({ identities, error: null as string | null }))
      .catch(error => ({ identities: [], error: error instanceof Error ? error.message : "SEC issuer identity source unavailable" })),
    fetchUsSymbolDirectory().then(directory => ({ directory, error: null as string | null }))
      .catch(error => ({ directory: null, error: error instanceof Error ? error.message : "US exchange symbol directory unavailable" })),
  ]);
  const byAccession = new Map<string, EdgarListingFiling>();
  for (const batch of fetched) for (const filing of batch.filings) byAccession.set(filing.accessionNumber, filing);
  let created = 0;
  for (const filing of byAccession.values()) if ((await persistFiling(svc, filing)).created) created++;
  let identityRows = 0;
  let identityResolution: any = null;
  let identityError: string | null = identityFetch.error;
  if (!identityError) {
    identityRows = identityFetch.identities.length;
    try { identityResolution = await resolveCurrentIssuerSymbols(svc, identityFetch.identities); }
    catch (error) { identityError = error instanceof Error ? error.message : "SEC issuer identity persistence failed"; }
  }
  // Nasdaq confirmed actual first trade; SpaceX's IPO was missed by the short
  // SEC daily-index window. Keep this correction in the candidate registry,
  // never the owner watchlist or any scoring/trading input.
  const spacex = await persistVerifiedListing(svc);
  const available = fetched.filter(x => x.status === "available").length;
  let directory: any;
  let directoryError: string | null = directoryFetch.error;
  if (directoryFetch.directory) {
    try { directory = await observeUsDirectoryDelta(svc, directoryFetch.directory); }
    catch (error) { directoryError = error instanceof Error ? error.message : "US exchange symbol directory persistence failed"; }
  }
  const directoryOk = !!directory && ["baseline", "complete", "unchanged"].includes(directory.status);
  const secOk = available === fetched.length && !identityError;
  const anySourceOk = available > 0 || directoryOk;
  const status = secOk && directoryOk ? "completed" : anySourceOk ? "partial" : "error";
  const summary = { policy: LISTING_DISCOVERY_POLICY, source: "sec_edgar_and_nasdaq_symbol_directories", status,
    dates: fetched.map(x => x.date), indexes: fetched.map(({ filings, ...index }) => ({ ...index, filing_count: index.status === "available" ? filings.length : null })),
    filings_seen: byAccession.size, candidates_created: created, verified_historical_listings_seeded: spacex.created ? 1 : 0,
    identity_map_source: "sec_company_tickers_exchange", identity_map_rows: identityRows, identity_resolution: identityResolution,
    identity_map_error: identityError, exchange_directory_source: US_SYMBOL_DIRECTORY_SOURCE, exchange_directory: directory ?? { status: "unavailable", error: directoryError },
    identity_resolution_note: "unresolved SEC CIKs may be legitimate pre-listing issuers; current ticker mapping does not establish first trade",
    influence: "none" };
  // agent_runs is operational health only; it is not used as listing evidence.
  const { error: runError } = await svc.from("agent_runs").insert({ agent_type: "listing_discovery", market: "us", status, started_at: startedAt, completed_at: new Date().toISOString(), result_summary: JSON.stringify(summary), symbols: [] });
  if (runError) throw new Error(`listing discovery run recording failed: ${runError.message}`);
  if (status === "completed") await resolveIssue("listing-discovery:us", svc);
  else await reportIssue({ issueKey: "listing-discovery:us", severity: "warn", category: "data",
    title: "US listing discovery sources are incomplete",
    detail: [
      ...fetched.filter(x => x.status === "unavailable").map(x => `${x.date}: ${x.error}`),
      identityError ? `SEC identity map: ${identityError}` : null,
      directoryError ? `Exchange directory: ${directoryError}` : null,
    ].filter(Boolean).join("; ") || "At least one listing evidence source did not complete." }, svc);
  return summary;
}

export async function POST(req: NextRequest) {
  const gate = await ownerOrCron(req); if (gate) return gate;
  if (req.nextUrl.searchParams.get("market") !== "us") return NextResponse.json({ error: "only US evidence-only discovery is available" }, { status: 400 });
  try { const result = await runDiscovery(); return NextResponse.json(result, { status: result.status === "error" ? 502 : 200 }); }
  catch (error) {
    const message = error instanceof Error ? error.message : "listing discovery failed";
    // A failed source must be visible; no row could be misread as zero additions.
    await createServiceClient().from("agent_runs").insert({ agent_type: "listing_discovery", market: "us", status: "error", started_at: new Date().toISOString(), completed_at: new Date().toISOString(), result_summary: JSON.stringify({ source: "sec_edgar_and_nasdaq_symbol_directories", error: message, influence: "none" }), symbols: [] });
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
