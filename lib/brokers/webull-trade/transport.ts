import type { WebullTradeCredential } from "./credentials";
import { assertHostMatchesEnv } from "./credentials";
import { webullTradeOrdersEnabled } from "./config";
import { paths } from "./endpoints";
import { evaluateGateLadder, type GateSnapshot } from "./gates";
import {
  buildSignatureHeaders,
  freshNonce,
  isTimestampFresh,
  nowTimestamp,
} from "./signing";
import type { WebullTradeEnv } from "./types";

export interface TransportRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: string;
  env: WebullTradeEnv;
}

export type TransportResult =
  | { ok: true; status: number; json: unknown }
  | { ok: false; timeout: boolean; error: string };

export interface WebullTransport {
  send(req: TransportRequest): Promise<TransportResult>;
}

const PERMIT_BRAND = Symbol("webull_transport_permit");
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_PERMIT_AGE_MS = 30_000;

type PermitKind = "preflight" | "order";

export interface WebullTransportPermit {
  readonly kind: PermitKind;
  readonly env: WebullTradeEnv;
  readonly issuedAt: number;
  readonly [PERMIT_BRAND]: true;
}

export type PermitResult =
  | { ok: true; permit: WebullTransportPermit }
  | { ok: false; error: string };

const PREFLIGHT_ENDPOINTS = new Map<string, TransportRequest["method"]>([
  [paths.tokenCheck, "POST"],
  [paths.accountList, "GET"],
  [paths.preview, "POST"],
]);

const ORDER_ENDPOINTS = new Map<string, TransportRequest["method"]>([
  [paths.place, "POST"],
  [paths.detail, "GET"],
  [paths.open, "GET"],
  [paths.cancel, "POST"],
]);

function mintPermit(kind: PermitKind, env: WebullTradeEnv, issuedAt: number): WebullTransportPermit {
  return Object.freeze({ kind, env, issuedAt, [PERMIT_BRAND]: true as const });
}

/**
 * Token status must be checked before gate 7 can pass. This narrowly-scoped
 * permit resolves that dependency without making an order endpoint reachable.
 */
export async function authorizeWebullPreflightTransport(
  svc: any,
  env: WebullTradeEnv,
  now: number = Date.now(),
): Promise<PermitResult> {
  if (!(await webullTradeOrdersEnabled(svc))) {
    return { ok: false, error: "webull_trade preflight disabled by feature flag" };
  }
  return { ok: true, permit: mintPermit("preflight", env, now) };
}

/** Mint a one-request order permit only after the complete money-path ladder. */
export function authorizeWebullOrderTransport(
  snapshot: GateSnapshot,
  env: WebullTradeEnv,
  now: number = Date.now(),
): PermitResult {
  if (env !== "prod") {
    return { ok: false, error: "webull_trade sandbox orders require a separately approved sandbox account gate" };
  }
  const gate = evaluateGateLadder(snapshot, now);
  if (!gate.ok) {
    return { ok: false, error: `webull_trade gate blocked: ${gate.failedGate}` };
  }
  return { ok: true, permit: mintPermit("order", env, now) };
}

function isAllowedRequest(permit: WebullTransportPermit, req: TransportRequest): boolean {
  const endpoints = permit.kind === "preflight" ? PREFLIGHT_ENDPOINTS : ORDER_ENDPOINTS;
  return endpoints.get(req.path) === req.method;
}

function buildQuery(query: TransportRequest["query"]): string {
  const params = new URLSearchParams();
  for (const key of Object.keys(query ?? {}).sort()) {
    const value = query?.[key];
    if (value !== undefined) params.append(key, String(value));
  }
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

function parseResponse(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function liveWebullTransport(opts: {
  credential: WebullTradeCredential;
  permit: WebullTransportPermit;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  nonce?: () => string;
}): WebullTransport {
  const { credential, permit } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const clock = opts.now ?? Date.now;
  const nonce = opts.nonce ?? freshNonce;

  if (permit?.[PERMIT_BRAND] !== true) throw new Error("webull_trade transport permit is invalid");
  if (!assertHostMatchesEnv(credential.env, credential.host) || permit.env !== credential.env) {
    throw new Error("webull_trade credential, permit, and endpoint environments do not match");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new Error("webull_trade timeout is invalid");
  }

  const baseUrl = new URL(credential.host);
  if (baseUrl.protocol !== "https:" || baseUrl.pathname !== "/" || baseUrl.search || baseUrl.hash) {
    throw new Error("webull_trade endpoint is invalid");
  }

  let consumed = false;

  return {
    async send(req: TransportRequest): Promise<TransportResult> {
      if (consumed) return { ok: false, timeout: false, error: "webull_trade transport permit already consumed" };
      consumed = true;

      const requestNow = clock();
      if (!Number.isFinite(requestNow) || requestNow < permit.issuedAt || requestNow - permit.issuedAt > MAX_PERMIT_AGE_MS) {
        return { ok: false, timeout: false, error: "webull_trade transport permit is stale" };
      }
      if (req.env !== credential.env || !isAllowedRequest(permit, req)) {
        return { ok: false, timeout: false, error: "webull_trade request is outside the permitted environment or capability" };
      }
      if (!req.path.startsWith("/openapi/") || req.path.includes("?") || req.path.includes("#")) {
        return { ok: false, timeout: false, error: "webull_trade request path is invalid" };
      }
      if (req.method === "GET" && req.body !== undefined) {
        return { ok: false, timeout: false, error: "webull_trade GET request cannot carry a body" };
      }

      const timestamp = nowTimestamp(requestNow);
      if (!isTimestampFresh(timestamp, requestNow)) {
        return { ok: false, timeout: false, error: "webull_trade timestamp is invalid" };
      }
      const requestNonce = nonce();
      if (!/^[A-Za-z0-9]{16,128}$/.test(requestNonce)) {
        return { ok: false, timeout: false, error: "webull_trade nonce is invalid" };
      }
      const signable = {
        method: req.method,
        path: req.path,
        query: req.query,
        body: req.body,
        appKey: credential.appKey,
        host: baseUrl.host,
        timestamp,
        nonce: requestNonce,
      };
      const headers: Record<string, string> = {
        Accept: "application/json",
        ...buildSignatureHeaders(signable, credential.appSecret),
        "x-access-token": credential.accessToken,
      };
      if (req.method !== "GET") headers["Content-Type"] = "application/json";

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(`${credential.host}${req.path}${buildQuery(req.query)}`, {
          method: req.method,
          headers,
          body: req.body,
          signal: controller.signal,
          redirect: "error",
          cache: "no-store",
        });
        const json = parseResponse(await response.text());
        if (!response.ok) {
          return {
            ok: false,
            timeout: false,
            error: `webull_trade request failed with HTTP ${response.status}`,
          };
        }
        return { ok: true, status: response.status, json };
      } catch (error) {
        const timedOut = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
        return {
          ok: false,
          timeout: timedOut,
          error: timedOut ? "webull_trade request timed out" : "webull_trade network request failed",
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
