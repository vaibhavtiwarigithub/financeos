import { createHash, createHmac, randomUUID, timingSafeEqual } from "crypto";

// Official Webull OpenAPI signing constants. Keep this module pure: it is an
// offline contract/test oracle and does not make a network request.
export const SIGNATURE_ALGORITHM = "HMAC-SHA1";
export const SIGNATURE_VERSION = "1.0";
export const API_VERSION = "v2";
export const DEFAULT_MAX_SKEW_MS = 5 * 60 * 1000;

export const HEADER = {
  appKey: "x-app-key",
  timestamp: "x-timestamp",
  nonce: "x-signature-nonce",
  algorithm: "x-signature-algorithm",
  version: "x-signature-version",
  apiVersion: "x-version",
  signature: "x-signature",
} as const;

export interface SignableRequest {
  path: string;
  host: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: string;
  appKey: string;
  nonce: string;
  timestamp: string;
  // Retained for call-site clarity. Webull does not include the method in the
  // signature string.
  method?: string;
}

function sortedSigningParams(req: SignableRequest): string {
  const params: Record<string, string> = {
    host: req.host,
    [HEADER.appKey]: req.appKey,
    [HEADER.algorithm]: SIGNATURE_ALGORITHM,
    [HEADER.nonce]: req.nonce,
    [HEADER.version]: SIGNATURE_VERSION,
    [HEADER.timestamp]: req.timestamp,
  };
  for (const [key, value] of Object.entries(req.query ?? {})) {
    if (value !== undefined) params[key] = String(value);
  }
  return Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
}

/** The exact URL-encoded byte string consumed by HMAC-SHA1. */
export function buildCanonicalRequest(req: SignableRequest): string {
  const bodyHash = req.body
    ? createHash("md5").update(req.body, "utf8").digest("hex").toUpperCase()
    : null;
  const raw = `${req.path}&${sortedSigningParams(req)}${bodyHash ? `&${bodyHash}` : ""}`;
  return encodeURIComponent(raw);
}

export function signCanonicalRequest(canonicalRequest: string, appSecret: string): string {
  return createHmac("sha1", `${appSecret}&`).update(canonicalRequest, "utf8").digest("base64");
}

export function signRequest(req: SignableRequest, appSecret: string): string {
  return signCanonicalRequest(buildCanonicalRequest(req), appSecret);
}

export function verifySignature(req: SignableRequest, appSecret: string, provided: string): boolean {
  if (typeof provided !== "string" || provided.length === 0) return false;
  const expected = signRequest(req, appSecret);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function freshNonce(): string {
  return randomUUID().replace(/-/g, "");
}

export function nowTimestamp(now: number = Date.now()): string {
  return new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function isTimestampFresh(
  timestamp: string,
  now: number = Date.now(),
  maxSkewMs: number = DEFAULT_MAX_SKEW_MS,
): boolean {
  const ts = Date.parse(timestamp);
  return Number.isFinite(ts) && Number.isFinite(maxSkewMs) && maxSkewMs >= 0 && Math.abs(now - ts) <= maxSkewMs;
}

export function buildSignatureHeaders(req: SignableRequest, appSecret: string): Record<string, string> {
  return {
    [HEADER.appKey]: req.appKey,
    [HEADER.timestamp]: req.timestamp,
    [HEADER.nonce]: req.nonce,
    [HEADER.algorithm]: SIGNATURE_ALGORITHM,
    [HEADER.version]: SIGNATURE_VERSION,
    [HEADER.apiVersion]: API_VERSION,
    [HEADER.signature]: signRequest(req, appSecret),
  };
}
