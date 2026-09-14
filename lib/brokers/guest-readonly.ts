// Read-only broker access for guests.
//
// "Guests are read-only" must not rest on nobody calling the order tools. The
// Robinhood MCP surface exposes `place_equity_order`, `cancel_equity_order` and
// friends, and `lib/kite.ts` exports `kitePost`/`kiteDelete` which can place and
// cancel orders. A guest client that merely *chose* not to call them would be
// one careless import away from placing a real trade with someone else's money.
//
// So this module returns an object that has no order method on it at all. There
// is nothing to call. The allowed operations are enumerated below and the type
// is closed, so adding an order path requires deliberately editing this file —
// which the test suite then fails.
//
// This is a capability boundary, not a policy: it cannot be bypassed by a caller
// that forgets a check, because the capability was never handed over.

import { loadGuestCredential, type GuestBroker } from "@/lib/brokers/guest-credentials";

/** Everything a guest client may do. Reads only — no order, cancel, or modify. */
export type GuestReadOnlyClient = {
  broker: GuestBroker;
  /** Current holdings, normalised to symbol/quantity/value. */
  holdings: () => Promise<{ ok: true; holdings: GuestHolding[] } | { ok: false; error: string }>;
};

export type GuestHolding = {
  symbol: string;
  quantity: number;
  averageCost: number | null;
  lastPrice: number | null;
  currency: string | null;
};

export type GuestClientRefusal = {
  ok: false;
  /** Why no client was produced. Distinguishes "reconnect" from "ask the owner". */
  reason: "not_connected" | "stale" | "access_revoked" | "undecryptable" | "unsupported";
};

const KITE_BASE = "https://api.kite.trade";

/**
 * Build a read-only client, or refuse.
 *
 * Refusal is a first-class outcome rather than an exception: a stale Zerodha
 * token is the EXPECTED daily state, not an error, and the caller must be able
 * to record it as a skip with a reason instead of failing a run.
 */
export async function guestReadOnlyClient(params: {
  userId: string;
  broker: GuestBroker;
  ownerEmail: string;
  kiteApiKey?: string;
  now?: Date;
}): Promise<GuestReadOnlyClient | GuestClientRefusal> {
  const loaded = await loadGuestCredential(params.userId, params.broker, params.ownerEmail, params.now);
  if (loaded.token === null) return { ok: false, reason: loaded.reason as GuestClientRefusal["reason"] };
  const token = loaded.token;

  if (params.broker === "kite") {
    if (!params.kiteApiKey) return { ok: false, reason: "unsupported" };
    return {
      broker: "kite",
      holdings: async () => {
        try {
          const res = await fetch(`${KITE_BASE}/portfolio/holdings`, {
            headers: {
              "X-Kite-Version": "3",
              Authorization: `token ${params.kiteApiKey}:${token}`,
            },
            signal: AbortSignal.timeout(15000),
          });
          const json = await res.json().catch(() => null);
          if (!res.ok || json?.status !== "success") {
            // Never echo the provider body — it can contain the token.
            return { ok: false, error: `Zerodha returned HTTP ${res.status}` };
          }
          return { ok: true, holdings: (json.data ?? []).map(normaliseKiteHolding) };
        } catch {
          return { ok: false, error: "Zerodha was unreachable" };
        }
      },
    };
  }

  // Robinhood arrives with its MCP driver in a later phase. Refusing is correct
  // until then: an unsupported broker must not silently fall back to the
  // OWNER's global credential, which is exactly the leak this feature exists to
  // avoid.
  return { ok: false, reason: "unsupported" };
}

function normaliseKiteHolding(row: any): GuestHolding {
  return {
    symbol: String(row?.tradingsymbol ?? ""),
    quantity: Number(row?.quantity ?? 0),
    averageCost: row?.average_price == null ? null : Number(row.average_price),
    lastPrice: row?.last_price == null ? null : Number(row.last_price),
    currency: "INR",
  };
}
