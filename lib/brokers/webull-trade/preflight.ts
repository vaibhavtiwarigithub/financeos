import { paths } from "./endpoints";
import type { WebullTransport } from "./transport";
import type { WebullTokenRecord, WebullTokenStatus, WebullTradeEnv } from "./types";

export type WebullTokenPreflightResult =
  | { ok: true; token: WebullTokenRecord }
  | { ok: false; error: string };

const TOKEN_STATUSES = new Set<WebullTokenStatus>([
  "PENDING",
  "NORMAL",
  "INVALID",
  "EXPIRED",
]);

function responseObject(json: unknown): Record<string, unknown> | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const root = json as Record<string, unknown>;
  const data = root.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return root;
}

function parseExpiry(value: unknown): string | null {
  const millis = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(millis) || millis <= 0) return null;
  try {
    return new Date(millis).toISOString();
  } catch {
    return null;
  }
}

export async function checkWebullTokenStatus(
  transport: WebullTransport,
  env: WebullTradeEnv,
  checkedAt: number = Date.now(),
): Promise<WebullTokenPreflightResult> {
  if (!Number.isFinite(checkedAt)) {
    return { ok: false, error: "webull_trade token check time is invalid" };
  }
  const result = await transport.send({ method: "POST", path: paths.tokenCheck, env });
  if (!result.ok) return { ok: false, error: result.error };

  const payload = responseObject(result.json);
  const rawStatus = typeof payload?.status === "string" ? payload.status.toUpperCase() : "";
  if (!TOKEN_STATUSES.has(rawStatus as WebullTokenStatus)) {
    return { ok: false, error: "webull_trade token check returned an unknown status" };
  }

  const status = rawStatus as WebullTokenStatus;
  const checkedAtIso = new Date(checkedAt).toISOString();
  return {
    ok: true,
    token: {
      status,
      expiresAt: parseExpiry(payload?.expires),
      serverStatusCheckedAt: checkedAtIso,
      // A successful signed token-check is itself the latest authenticated call.
      lastAuthenticatedCallAt: checkedAtIso,
    },
  };
}
