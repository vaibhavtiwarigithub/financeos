import type { WebullTradeCredential } from "./credentials";
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

/**
 * Deliberately unavailable. The prior implementation accepted a caller-supplied
 * `enabled: true` and then owned a real global `fetch`, which let any internal
 * caller bypass the database gate ladder. Keep fixture transports injectable,
 * but do not ship a network-capable constructor until a single DB-backed order
 * gateway owns all gates, token status, reconciliation, and audit persistence.
 */
export function liveWebullTransport(_opts: {
  enabled: boolean;
  credential: WebullTradeCredential;
  timeoutMs?: number;
}): never {
  throw new Error("liveWebullTransport is not implemented; Webull network calls are disabled");
}
