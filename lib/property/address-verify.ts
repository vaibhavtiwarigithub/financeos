// Property address verification — "is this a real address?"
//
// Separate contract from lib/property/geocode.ts. Geocode answers "which county
// is this in" (Census). This answers "does the postal service believe this
// address exists". They can disagree, and both are stored.
//
// FAIL CLOSED. Every non-success path returns an explicit state with a
// plain-English reason. Nothing here ever returns "verified" unless USPS handed
// back a standardized deliverable address. An address that cannot be verified is
// FLAGGED, never rejected: the owner may know a property the API does not.
//
// India: USPS does not cover it and no free Indian address validator is wired,
// so Bengaluru addresses return `no_validator` honestly rather than a fake pass.

import { reportIssue, resolveIssue } from "@/lib/system-health";
import type { PropertyAddress } from "@/lib/property/geocode";

export type AddressVerificationState =
  /** USPS returned a standardized, deliverable address. */
  | "verified"
  /** USPS was reached and says no such address exists. */
  | "not_found"
  /** No USPS credential configured — nothing was checked. */
  | "not_configured"
  /** Outside USPS coverage (India) and no validator wired for that market. */
  | "no_validator"
  /** USPS was configured but unreachable / erroring — result unknown. */
  | "unavailable";

export type AddressVerification = {
  state: AddressVerificationState;
  source: "usps" | "none";
  /** ISO timestamp of the check. Lets the UI show a stale verification as stale. */
  checkedAt: string;
  /** USPS-standardized one-line address, only when state === "verified". */
  standardized?: string;
  postalCode?: string;
  /** What/why/next, shown verbatim in the UI. Never a bare status word. */
  reason: string;
};

const USPS_ISSUE_KEY = "property-address-verify:usps";

const now = () => new Date().toISOString();

function result(state: AddressVerificationState, reason: string, extra: Partial<AddressVerification> = {}): AddressVerification {
  return { state, source: state === "not_configured" || state === "no_validator" ? "none" : "usps", checkedAt: now(), reason, ...extra };
}

export function uspsCredentials(env: NodeJS.ProcessEnv = process.env): { key: string; secret: string } | null {
  const key = env.USPS_CONSUMER_KEY?.trim();
  const secret = env.USPS_CONSUMER_SECRET?.trim();
  return key && secret ? { key, secret } : null;
}

/**
 * Turn a USPS /addresses/v3/address response into a verification result.
 * Pure — no network, no env. `status` is the HTTP status USPS replied with.
 *
 * Fail-closed rule: a 200 that lacks a standardized street + ZIP is NOT a pass.
 * USPS echoes input on some partial matches, and treating that as "verified"
 * would let a nonexistent address through, which is the whole bug being fixed.
 */
export function parseUspsAddressResponse(status: number, payload: unknown): AddressVerification {
  const body = (payload ?? {}) as { address?: Record<string, unknown>; additionalInfo?: Record<string, unknown>; matches?: unknown[]; error?: { message?: string } };
  const uspsMessage = typeof body.error?.message === "string" ? body.error.message.trim().slice(0, 160) : "";

  if (status === 200) {
    const address = body.address ?? {};
    const street = typeof address.streetAddress === "string" ? address.streetAddress.trim() : "";
    const zip = typeof address.ZIPCode === "string" ? address.ZIPCode.trim() : "";
    const city = typeof address.city === "string" ? address.city.trim() : "";
    const state = typeof address.state === "string" ? address.state.trim() : "";
    const dpv = String(body.additionalInfo?.DPVConfirmation ?? "").toUpperCase();
    const ambiguous = Array.isArray(body.matches) && body.matches.length > 1;
    if (!street || !zip || dpv !== "Y" || ambiguous) {
      return result("not_found", "USPS answered but returned no standardized street and ZIP for this address, so it is not confirmed deliverable. Next: re-check the street number, unit, and ZIP, or save anyway if you know the property is real.");
    }
    const plus4 = typeof address.ZIPPlus4 === "string" && address.ZIPPlus4.trim() ? `-${address.ZIPPlus4.trim()}` : "";
    return result("verified", "USPS matched this to a real, deliverable address and standardized it. Next: nothing — the standardized form is stored with the property.", {
      standardized: [street, [city, state].filter(Boolean).join(" "), `${zip}${plus4}`].filter(Boolean).join(", "),
      postalCode: zip,
    });
  }

  if (status === 400 || status === 404) {
    return result("not_found", `USPS could not find this address${uspsMessage ? ` (${uspsMessage})` : ""}. Next: correct the street, city, two-letter state, and ZIP, or save anyway if you know the property is real — it will stay flagged as unverified.`);
  }

  if (status === 401 || status === 403) {
    return result("unavailable", "USPS rejected the configured credential, so the address was not checked. Next: confirm USPS_CONSUMER_KEY / USPS_CONSUMER_SECRET belong to an approved USPS APIs app with the Addresses API enabled.");
  }

  return result("unavailable", `USPS returned ${status} and the address could not be checked. Next: retry later; the property saves and stays flagged as unverified until a check succeeds.`);
}

// USPS OAuth2 tokens are valid ~8h. One in-process cache entry; a cold lambda
// just fetches a new one.
// ponytail: module-level cache, move to the vault if multiple routes start
// paying the token round-trip on every request.
let tokenCache: { token: string; expiresAt: number } | null = null;

async function uspsToken(credentials: { key: string; secret: string }): Promise<string | null> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
  try {
    const response = await fetch("https://apis.usps.com/oauth2/v3/token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ grant_type: "client_credentials", client_id: credentials.key, client_secret: credentials.secret }),
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!payload.access_token) return null;
    tokenCache = { token: payload.access_token, expiresAt: Date.now() + Math.max(60, Number(payload.expires_in) || 3_600) * 1_000 };
    return tokenCache.token;
  } catch {
    return null;
  }
}

/** Health reporting must never break a property save. */
async function health(state: AddressVerificationState, reason: string): Promise<void> {
  try {
    if (state === "unavailable") {
      await reportIssue({ issueKey: USPS_ISSUE_KEY, severity: "warn", category: "provider", title: "USPS address verification is failing", detail: reason });
    } else if (state === "verified" || state === "not_found") {
      await resolveIssue(USPS_ISSUE_KEY);
    }
  } catch {
    /* health reporting is best-effort */
  }
}

export function hasCompleteUsAddress(address: Partial<PropertyAddress> | undefined): boolean {
  return Boolean(address?.addressLine && address.city && address.region && address.postalCode);
}

/**
 * Verify a property address. `market` is the property market id; anything that
 * is not a US market has no wired validator and is reported as such.
 */
export async function verifyPropertyAddress(address: Partial<PropertyAddress> | undefined, market: string): Promise<AddressVerification> {
  if (market === "bengaluru") {
    return result("no_validator", "India addresses are not covered by USPS and no free Indian address validator is wired, so this address is recorded unverified. Next: treat the address as owner-asserted; nothing you can configure changes this today.");
  }
  if (!hasCompleteUsAddress(address)) {
    return result("not_found", "Street, city, state, and ZIP are all needed before an address can be checked. Next: fill in the missing field, or leave the address blank if you only want to track the ZIP.");
  }
  const credentials = uspsCredentials();
  if (!credentials) {
    return result("not_configured", "Address verification is not configured, so this address was not checked. Next: create a free account at https://developers.usps.com, add an app with the Addresses API, and set USPS_CONSUMER_KEY and USPS_CONSUMER_SECRET in .env.local and Vercel.");
  }

  const token = await uspsToken(credentials);
  if (!token) {
    const failure = result("unavailable", "USPS did not issue an access token, so the address could not be checked. Next: verify USPS_CONSUMER_KEY / USPS_CONSUMER_SECRET are current and the USPS APIs platform is reachable.");
    await health(failure.state, failure.reason);
    return failure;
  }

  const url = new URL("https://apis.usps.com/addresses/v3/address");
  url.searchParams.set("streetAddress", address!.addressLine!);
  url.searchParams.set("city", address!.city!);
  url.searchParams.set("state", address!.region!);
  url.searchParams.set("ZIPCode", address!.postalCode!.slice(0, 5));

  let verification: AddressVerification;
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });
    verification = parseUspsAddressResponse(response.status, await response.json().catch(() => null));
  } catch {
    verification = result("unavailable", "The USPS address service timed out or was unreachable, so the address could not be checked. Next: retry later; the property saves and stays flagged as unverified.");
  }
  await health(verification.state, verification.reason);
  return verification;
}

/** Short label for a verification state. The reason string carries the detail. */
export const ADDRESS_VERIFICATION_LABEL: Record<AddressVerificationState, string> = {
  verified: "Address verified by USPS",
  not_found: "Address not found — unverified",
  not_configured: "Address verification is not configured",
  no_validator: "Unverified — no free validator for this market",
  unavailable: "Address check failed — unverified",
};
