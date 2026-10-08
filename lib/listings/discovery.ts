import type { EdgarListingFiling } from "./sec-edgar";
import type { SecCurrentIssuerListing } from "./sec-edgar";

export const LISTING_DISCOVERY_POLICY = "listing-discovery-p1";

/** Observation research is never an admission decision, regardless of score. */
export function isListingObservationEntryEligible(source: string | null | undefined, candidateEligible: boolean): boolean {
  return source !== "new_listing_observation" && candidateEligible;
}

export function selectUnambiguousIdentityForCik(rows: SecCurrentIssuerListing[], rawCik: string) {
  const cik = rawCik.replace(/\D/g, "").padStart(10, "0");
  const matches = rows.filter(row => row.cik === cik);
  const unique = [...new Map(matches.map(row => [`${row.symbol}:${row.exchange}`, row])).values()];
  return { identity: unique.length === 1 ? unique[0] : null, ambiguous: unique.length > 1 };
}

export function stateAfterVerifiedFirstTrade(current: string | null | undefined): string {
  const observedStates = new Set(["pre_listing", "announced", "listed_observing"]);
  return !current || observedStates.has(current) ? "listed_observing" : current;
}

export function candidateStateForFiling(form: string): "pre_listing" | "announced" {
  // A prospectus is stronger evidence that a listing is imminent, but neither
  // it nor an S-1 is evidence of an exchange's first-trade date.
  return form === "424B4" ? "announced" : "pre_listing";
}

export function candidateRowForFiling(filing: EdgarListingFiling, now = new Date()) {
  const state = candidateStateForFiling(filing.form);
  return {
    market: "us", issuer_key: filing.cik, listing_key: `sec-cik:${filing.cik}`,
    company_name: filing.companyName, state, announced_at: state === "announced" ? `${filing.filedAt}T00:00:00.000Z` : null,
    source: "sec_edgar_daily_index", source_event_id: filing.accessionNumber, source_url: filing.sourceUrl,
    source_payload_hash: filing.payloadHash, last_seen_at: now.toISOString(), updated_at: now.toISOString(),
  };
}
