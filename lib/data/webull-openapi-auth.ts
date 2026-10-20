import {
  buildSignatureHeaders,
  freshNonce,
  nowTimestamp,
  type SignableRequest,
} from "@/lib/brokers/webull-trade/signing";
import { normalizeWebullCredential, type WebullOpenApiCredentials } from "@/lib/data/webull-openapi-preflight";

const HOST = "api.webull.com";
const BASE_URL = `https://${HOST}`;
const TOKEN_PATHS = {
  create: "/auth/tokens/create",
  check: "/auth/tokens/check",
} as const;

export type WebullTokenStatus = "PENDING" | "NORMAL" | "INVALID" | "EXPIRED";
export type WebullTokenResult =
  | { state: "credentials_missing"; detail: "app_key_missing" | "app_secret_missing" }
  | { state: "token_required" }
  | { state: "request_failed"; detail: "timeout" | "network_error" }
  | { state: "http_rejected"; httpStatus: number; detail: "authentication_failed" | "rate_limited" | "provider_error" }
  | { state: "schema_invalid"; httpStatus: 200 }
  | { state: "token_status"; httpStatus: 200; status: WebullTokenStatus; token?: string; expiresAt?: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function callWebullTokenApi(
  action: "create" | "check",
  credentials: WebullOpenApiCredentials,
  options: { fetcher?: typeof fetch; timeoutMs?: number; now?: () => number } = {},
): Promise<WebullTokenResult> {
  const appKey = normalizeWebullCredential(credentials.appKey);
  const appSecret = normalizeWebullCredential(credentials.appSecret);
  const accessToken = normalizeWebullCredential(credentials.accessToken);
  if (!appKey) return { state: "credentials_missing", detail: "app_key_missing" };
  if (!appSecret) return { state: "credentials_missing", detail: "app_secret_missing" };
  if (action === "check" && !accessToken) return { state: "token_required" };

  const path = TOKEN_PATHS[action];
  const request: SignableRequest = {
    path,
    host: HOST,
    appKey,
    nonce: freshNonce(),
    timestamp: nowTimestamp((options.now ?? Date.now)()),
    method: "POST",
    body: "",
  };
  const headers = {
    ...buildSignatureHeaders(request, appSecret, "v3"),
    ...(action === "check" && accessToken ? { "x-access-token": accessToken } : {}),
    accept: "application/json",
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000);
  try {
    const response = await (options.fetcher ?? fetch)(`${BASE_URL}${path}`, {
      method: "POST",
      headers,
      body: "",
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) {
      return {
        state: "http_rejected",
        httpStatus: response.status,
        detail: response.status === 401 ? "authentication_failed" : response.status === 429 ? "rate_limited" : "provider_error",
      };
    }
    let payload: unknown;
    try { payload = await response.json(); } catch { return { state: "schema_invalid", httpStatus: 200 }; }
    if (!isRecord(payload) || !["PENDING", "NORMAL", "INVALID", "EXPIRED"].includes(String(payload.status))) {
      return { state: "schema_invalid", httpStatus: 200 };
    }
    const status = payload.status as WebullTokenStatus;
    if (action === "create") {
      const token = typeof payload.token === "string" && /^[a-f0-9]{32}$/i.test(payload.token) ? payload.token : null;
      const expiresAt = typeof payload.expires_at === "number" && Number.isFinite(payload.expires_at) ? payload.expires_at : null;
      if (!token || !expiresAt || !Number.isFinite(new Date(expiresAt).getTime())) return { state: "schema_invalid", httpStatus: 200 };
      return { state: "token_status", httpStatus: 200, status, token, expiresAt };
    }
    return { state: "token_status", httpStatus: 200, status };
  } catch (error) {
    return { state: "request_failed", detail: (error as any)?.name === "AbortError" ? "timeout" : "network_error" };
  } finally {
    clearTimeout(timeout);
  }
}
