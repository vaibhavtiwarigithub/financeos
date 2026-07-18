// ============================================================================
// webull_trade — signed HTTP transport.
// ----------------------------------------------------------------------------
// The transport is the ONLY place a network request is made. It is injectable so
// the entire order lifecycle is tested against fixtures with NO network. The live
// transport (`liveWebullTransport`) is guarded so it CANNOT be constructed unless
// explicitly enabled — it throws at construction time otherwise. Combined with
// the gate ladder (which fails closed because webull_trade_orders_enabled does
// not exist in prod), this means there is no code path from the build/test
// environment to a live or sandbox Webull call.
//
// The live transport signs each request (fresh nonce + current timestamp per
// request), pins the host to the credential's environment, and asserts the host
// matches the env as a last line before the wire. It never logs the secret,
// signature, canonical request, token, or account id.
// ============================================================================

import { assertHostMatchesEnv } from "./credentials";
import type { WebullTradeCredential } from "./credentials";
import { buildSignatureHeaders, freshNonce, nowTimestamp } from "./signing";
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

// Live transport — DISABLED by construction unless `enabled === true`. Nothing in
// the repo constructs it with enabled=true; the flag is set only in the future
// live phase after the owner confirms entitlement and a sandbox proof.
export function liveWebullTransport(opts: {
  enabled: boolean;
  credential: WebullTradeCredential;
  timeoutMs?: number;
}): WebullTransport {
  if (opts.enabled !== true) {
    throw new Error(
      "liveWebullTransport is disabled — webull_trade live/sandbox calls require explicit enablement after owner entitlement + sandbox proof",
    );
  }
  const { credential } = opts;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  return {
    async send(req: TransportRequest): Promise<TransportResult> {
      // Last-line env/host pin: a sandbox credential can never hit a prod host.
      if (req.env !== credential.env || !assertHostMatchesEnv(credential.env, credential.host)) {
        return { ok: false, timeout: false, error: "env/host mismatch — refusing to send" };
      }
      const timestamp = nowTimestamp();
      const nonce = freshNonce();
      const headers = buildSignatureHeaders(
        { method: req.method, path: req.path, query: req.query, body: req.body, appKey: credential.appKey, nonce, timestamp },
        credential.appSecret,
      );
      const url = new URL(credential.host + req.path);
      if (req.query) {
        for (const [k, v] of Object.entries(req.query)) {
          if (v !== undefined) url.searchParams.set(k, String(v));
        }
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url.toString(), {
          method: req.method,
          headers: { ...headers, "content-type": "application/json" },
          body: req.method === "GET" ? undefined : req.body,
          signal: controller.signal,
        });
        const text = await res.text();
        let json: unknown = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = { _raw: text };
        }
        return { ok: res.ok, status: res.status, json } as TransportResult;
      } catch (e) {
        const timeout = (e as any)?.name === "AbortError";
        // Never leak request internals; return a generic error.
        return { ok: false, timeout, error: timeout ? "request timed out" : "transport error" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
