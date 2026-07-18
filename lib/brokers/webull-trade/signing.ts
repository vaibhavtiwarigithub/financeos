// ============================================================================
// webull_trade — request signing (HMAC-SHA1) per the spec §"Credential and
// Transport Design". Implemented DIRECTLY (no vendor SDK) so the canonical
// request is one auditable place.
//
// SIGNING CONTRACT (canonical request):
//   canonicalRequest =
//     METHOD          + "\n" +   // upper-cased HTTP verb
//     PATH            + "\n" +   // request path, no host, no query
//     CANONICAL_QUERY + "\n" +   // query params sorted by key, "k=v" joined by "&"
//     BODY            + "\n" +   // exact request body bytes ("" when none)
//     X-APP-KEY       + "\n" +
//     X-SIGNATURE-NONCE + "\n" + // fresh, unique per request
//     X-TIMESTAMP                // epoch milliseconds as a decimal string
//
//   signature = hexLower( HMAC_SHA1( appSecret, canonicalRequest ) )
//
// DEPENDENCY / RECONCILIATION NOTE: the canonical byte layout above is the
// documented HMAC-SHA1 shape, and the golden fixtures in this repo prove the
// implementation is deterministic and mutation-sensitive (any change to method,
// path, query, body, nonce, or timestamp changes the signature). Before the FIRST
// live or sandbox call the owner must reconcile this exact canonical layout
// against the CURRENT official Webull signing docs/SDK and, if it differs, update
// ONLY buildCanonicalRequest + regenerate the golden fixtures. Nothing else in the
// module depends on the layout. This reconciliation is part of the entitlement /
// sandbox-proof gate — it never happens on the build environment.
// ============================================================================

import { createHmac, randomUUID, timingSafeEqual } from "crypto";

export const SIGNATURE_ALGORITHM = "HmacSHA1";
export const SIGNATURE_VERSION = "v1";

// Max acceptable clock skew between our timestamp and "now" at verify time.
export const DEFAULT_MAX_SKEW_MS = 5 * 60 * 1000; // 5 minutes

export const HEADER = {
  appKey: "x-app-key",
  timestamp: "x-timestamp",
  nonce: "x-signature-nonce",
  algorithm: "x-signature-algorithm",
  version: "x-signature-version",
  signature: "x-signature",
} as const;

export interface SignableRequest {
  method: string;
  path: string;
  // Query params (may be empty). Order-independent — canonicalized by sort.
  query?: Record<string, string | number | boolean | undefined>;
  // Exact request body string ("" or undefined when none).
  body?: string;
  appKey: string;
  nonce: string;
  timestamp: string; // epoch millis, decimal string
}

// Deterministic canonical query string: sort by key, drop undefined, join "k=v".
function canonicalQuery(query?: SignableRequest["query"]): string {
  if (!query) return "";
  const entries = Object.entries(query)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => [k, String(v)] as [string, string])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.map(([k, v]) => `${k}=${v}`).join("&");
}

export function buildCanonicalRequest(req: SignableRequest): string {
  return [
    req.method.toUpperCase(),
    req.path,
    canonicalQuery(req.query),
    req.body ?? "",
    req.appKey,
    req.nonce,
    req.timestamp,
  ].join("\n");
}

// hexLower(HMAC-SHA1(appSecret, canonicalRequest)). The secret NEVER appears in
// the return value, in any error, or in any log.
export function signCanonicalRequest(canonicalRequest: string, appSecret: string): string {
  return createHmac("sha1", appSecret).update(canonicalRequest, "utf8").digest("hex");
}

export function signRequest(req: SignableRequest, appSecret: string): string {
  return signCanonicalRequest(buildCanonicalRequest(req), appSecret);
}

// Constant-time signature comparison. Returns false (never throws) on any shape
// mismatch, so a malformed/short signature can't crash the verifier.
export function verifySignature(req: SignableRequest, appSecret: string, provided: string): boolean {
  if (typeof provided !== "string" || provided.length === 0) return false;
  const expected = signRequest(req, appSecret);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Fresh nonce per request. Never reused across requests.
export function freshNonce(): string {
  return randomUUID();
}

export function nowTimestamp(now: number = Date.now()): string {
  return String(now);
}

// Timestamp-skew guard (fail closed). Rejects a non-numeric, non-finite, or
// out-of-window timestamp. Used before trusting a signed request's freshness and
// to refuse replaying an old/forward-dated timestamp.
export function isTimestampFresh(
  timestamp: string,
  now: number = Date.now(),
  maxSkewMs: number = DEFAULT_MAX_SKEW_MS,
): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  return Math.abs(now - ts) <= maxSkewMs;
}

// Assemble the signature headers for an outbound request. Pure — the caller
// (transport) attaches these; it does not log them.
export function buildSignatureHeaders(req: SignableRequest, appSecret: string): Record<string, string> {
  return {
    [HEADER.appKey]: req.appKey,
    [HEADER.timestamp]: req.timestamp,
    [HEADER.nonce]: req.nonce,
    [HEADER.algorithm]: SIGNATURE_ALGORITHM,
    [HEADER.version]: SIGNATURE_VERSION,
    [HEADER.signature]: signRequest(req, appSecret),
  };
}
