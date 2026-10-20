import {
  buildSignatureHeaders,
  freshNonce,
  nowTimestamp,
  type SignableRequest,
} from "@/lib/brokers/webull-trade/signing";

const HOST = "api.webull.com";
const BASE_URL = `https://${HOST}`;
const SNAPSHOT_PATH = "/market-data/stocks/snapshots/list";
const SNAPSHOT_QUERY = {
  symbols: "AAPL",
  category: "US_STOCK",
  extend_hour_required: "false",
  overnight_required: "false",
} as const;

// .env files should use ASCII quoting, but tolerate one accidental pair of
// surrounding ASCII/Unicode quote characters without changing the file or
// ever returning the credential to a caller.
const EDGE_QUOTES = new Set(["\"", "'", "`", "\u201c", "\u201d", "\u2018", "\u2019"]);
export function normalizeWebullCredential(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  let normalized = value.trim();
  if (normalized.length >= 2 && EDGE_QUOTES.has(normalized[0]) && EDGE_QUOTES.has(normalized[normalized.length - 1])) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized || null;
}

export interface WebullOpenApiCredentials {
  appKey: string | null;
  appSecret: string | null;
  accessToken: string | null;
}

export type WebullPreflightResult =
  | { state: "credentials_missing"; detail: "app_key_missing" | "app_secret_missing" }
  | { state: "access_token_required"; detail: "access_token_missing" }
  | { state: "request_failed"; detail: "timeout" | "network_error" }
  | { state: "http_rejected"; httpStatus: number; detail: "authentication_failed" | "entitlement_or_scope_denied" | "rate_limited" | "provider_error" }
  | { state: "schema_invalid"; httpStatus: 200 }
  | { state: "snapshot_contract_valid"; httpStatus: 200; symbol: "AAPL"; lastTradeTime: string | null; hasPrice: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function snapshotRow(payload: unknown): Record<string, unknown> | null {
  if (Array.isArray(payload)) {
    return payload.find((row) => isRecord(row) && String(row.symbol ?? "").toUpperCase() === "AAPL") as Record<string, unknown> | undefined ?? null;
  }
  if (isRecord(payload)) {
    const rows = payload.data ?? payload.items ?? payload.list;
    if (Array.isArray(rows)) return snapshotRow(rows);
  }
  return null;
}

export async function runWebullOpenApiPreflight(
  credentials: WebullOpenApiCredentials,
  options: { fetcher?: typeof fetch; timeoutMs?: number; now?: () => number } = {},
): Promise<WebullPreflightResult> {
  const appKey = normalizeWebullCredential(credentials.appKey);
  const appSecret = normalizeWebullCredential(credentials.appSecret);
  const accessToken = normalizeWebullCredential(credentials.accessToken);
  if (!appKey) return { state: "credentials_missing", detail: "app_key_missing" };
  if (!appSecret) return { state: "credentials_missing", detail: "app_secret_missing" };
  // This account's prior read-only probe received Webull's explicit
  // INVALID_TOKEN response when x-access-token was omitted. Require a token
  // here rather than repeatedly sending a request that cannot pass its auth.
  if (!accessToken) return { state: "access_token_required", detail: "access_token_missing" };

  const timestamp = nowTimestamp((options.now ?? Date.now)());
  const request: SignableRequest = {
    path: SNAPSHOT_PATH,
    host: HOST,
    query: SNAPSHOT_QUERY,
    appKey,
    nonce: freshNonce(),
    timestamp,
    method: "GET",
  };
  const headers = {
    ...buildSignatureHeaders(request, appSecret, "v3"),
    "x-access-token": accessToken,
    accept: "application/json",
  };
  const url = new URL(`${BASE_URL}${SNAPSHOT_PATH}`);
  for (const [key, value] of Object.entries(SNAPSHOT_QUERY)) url.searchParams.set(key, value);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000);
  try {
    const response = await (options.fetcher ?? fetch)(url, {
      method: "GET",
      headers,
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) {
      const detail = response.status === 401 ? "authentication_failed"
        : response.status === 403 ? "entitlement_or_scope_denied"
          : response.status === 429 ? "rate_limited" : "provider_error";
      return { state: "http_rejected", httpStatus: response.status, detail };
    }
    let payload: unknown;
    try { payload = await response.json(); } catch { return { state: "schema_invalid", httpStatus: 200 }; }
    const row = snapshotRow(payload);
    if (!row) return { state: "schema_invalid", httpStatus: 200 };
    const price = Number(row.price);
    const hasPrice = Number.isFinite(price) && price > 0;
    const rawTime = row.last_trade_time;
    const parsedMs = typeof rawTime === "number" ? (rawTime < 100_000_000_000 ? rawTime * 1000 : rawTime)
      : typeof rawTime === "string" && /^\d{10,13}$/.test(rawTime) ? (rawTime.length === 10 ? Number(rawTime) * 1000 : Number(rawTime))
        : typeof rawTime === "string" ? Date.parse(rawTime) : NaN;
    const parsedDate = Number.isFinite(parsedMs) ? new Date(parsedMs) : null;
    const lastTradeTime = parsedDate && Number.isFinite(parsedDate.getTime()) ? parsedDate.toISOString() : null;
    if (!hasPrice || !lastTradeTime) return { state: "schema_invalid", httpStatus: 200 };
    return { state: "snapshot_contract_valid", httpStatus: 200, symbol: "AAPL", lastTradeTime, hasPrice };
  } catch (error) {
    return { state: "request_failed", detail: (error as any)?.name === "AbortError" ? "timeout" : "network_error" };
  } finally {
    clearTimeout(timeout);
  }
}
