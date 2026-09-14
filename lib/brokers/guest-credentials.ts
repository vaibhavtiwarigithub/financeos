// Per-user broker credentials: store, load, disconnect, and report staleness.
//
// Separate from `lib/kite.ts` and `lib/brokers/mcp-driver.ts`, which manage the
// OWNER's single global credential in `api_key_vault`. Nothing here touches that
// table, and nothing there touches this one.
//
// Two rules are enforced on every load rather than left to callers:
//
//   1. A credential is only usable while its owner still has an ACTIVE grant.
//      Revoking someone's access revokes their broker connection with it —
//      one revocation, both effects — so a revoked guest cannot keep a
//      background job running against their broker.
//
//   2. Kite tokens expire at the end of each trading day. The owner accepted
//      that daily login (2026-09-14) ON CONDITION that staleness is shown
//      loudly, so freshness is computed here and returned as data. A caller
//      cannot accidentally treat an expired token's output as current, because
//      the load simply does not return a usable credential.

import { createServiceClient } from "@/lib/supabase/service";
import { encryptCredential, decryptCredential, credentialFingerprint } from "@/lib/security/credential-cipher";

export type GuestBroker = "robinhood" | "kite";

export type ConnectionState = {
  broker: GuestBroker;
  connected: boolean;
  /** True when connected but the credential can no longer be used today. */
  stale: boolean;
  /** Plain-language cause, shown to the user verbatim. Null when healthy. */
  staleReason: string | null;
  connectedAt: string | null;
  lastVerifiedAt: string | null;
  lastError: string | null;
};

/** IST calendar date, the day boundary Zerodha expires tokens on. */
export function istCalendarDate(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Is a stored credential still usable?
 *
 * Pure, so the rule is testable without a database or a clock. Kite is the only
 * broker with a hard daily expiry: a token is good only on the IST day it was
 * issued. Robinhood's MCP tokens refresh, so absent an explicit `expires_at`
 * they are treated as live.
 */
export function credentialFreshness(
  broker: GuestBroker,
  connectedAt: string | null,
  expiresAt: string | null,
  now: Date = new Date(),
): { fresh: boolean; reason: string | null } {
  if (expiresAt && new Date(expiresAt).getTime() <= now.getTime()) {
    return { fresh: false, reason: "The saved broker session has expired. Reconnect to refresh your risk analytics." };
  }
  if (broker === "kite") {
    if (!connectedAt) return { fresh: false, reason: "No Zerodha session recorded. Connect to Zerodha to see today's risk." };
    if (istCalendarDate(new Date(connectedAt)) !== istCalendarDate(now)) {
      return {
        fresh: false,
        reason:
          "Zerodha sessions expire at the end of each trading day. Log in to Zerodha again to refresh — until then these figures are from your last connected day.",
      };
    }
  }
  return { fresh: true, reason: null };
}

/** Does this account still hold access at all? Owner always does. */
async function hasActiveAccess(svc: any, userId: string, ownerEmail: string): Promise<boolean> {
  const { data: grant } = await svc
    .from("app_user_roles")
    .select("revoked_at, email")
    .eq("user_id", userId)
    .maybeSingle();
  if (grant) return !grant.revoked_at;
  // No grant row: only the owner's own account qualifies.
  const { data: user } = await svc.auth.admin.getUserById(userId).catch(() => ({ data: null }));
  return String(user?.user?.email ?? "").toLowerCase() === ownerEmail.toLowerCase();
}

export async function storeGuestCredential(params: {
  userId: string;
  broker: GuestBroker;
  token: string;
  expiresAt?: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const svc = createServiceClient();
  try {
    const { error } = await svc.from("user_broker_credentials").upsert(
      {
        user_id: params.userId,
        broker: params.broker,
        scope: "read_only",
        ciphertext: encryptCredential(params.token),
        fingerprint: credentialFingerprint(params.token),
        expires_at: params.expiresAt ?? null,
        connected_at: new Date().toISOString(),
        last_verified_at: new Date().toISOString(),
        last_error: null,
        disconnected_at: null,
      },
      { onConflict: "user_id,broker" },
    );
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err: any) {
    // Includes the cipher's refusal when BROKER_CREDENTIAL_KEY is missing or
    // weak. Surfaced as-is: refusing to connect is the correct outcome, and the
    // message never contains the token.
    return { ok: false, error: String(err?.message ?? err) };
  }
}

/**
 * The decrypted token, or null with a reason.
 *
 * Returns null for a revoked account and for a stale credential alike — a
 * caller cannot obtain a token it should not use.
 */
export async function loadGuestCredential(
  userId: string,
  broker: GuestBroker,
  ownerEmail: string,
  now: Date = new Date(),
): Promise<{ token: string } | { token: null; reason: string }> {
  const svc = createServiceClient();

  if (!(await hasActiveAccess(svc, userId, ownerEmail))) {
    return { token: null, reason: "access_revoked" };
  }

  const { data } = await svc
    .from("user_broker_credentials")
    .select("ciphertext, connected_at, expires_at, disconnected_at")
    .eq("user_id", userId)
    .eq("broker", broker)
    .maybeSingle();

  if (!data || data.disconnected_at) return { token: null, reason: "not_connected" };

  const freshness = credentialFreshness(broker, data.connected_at, data.expires_at, now);
  if (!freshness.fresh) return { token: null, reason: "stale" };

  try {
    return { token: decryptCredential(data.ciphertext) };
  } catch {
    return { token: null, reason: "undecryptable" };
  }
}

/** Non-secret connection state for the UI. Never touches the ciphertext. */
export async function guestConnectionStates(
  userId: string,
  now: Date = new Date(),
): Promise<ConnectionState[]> {
  const svc = createServiceClient();
  const { data } = await svc
    .from("user_broker_credentials")
    .select("broker, connected_at, expires_at, last_verified_at, last_error, disconnected_at")
    .eq("user_id", userId);

  const byBroker = new Map<string, any>();
  for (const row of data ?? []) byBroker.set(String(row.broker), row);

  return (["robinhood", "kite"] as GuestBroker[]).map((broker) => {
    const row = byBroker.get(broker);
    const connected = Boolean(row && !row.disconnected_at);
    if (!connected) {
      return { broker, connected: false, stale: false, staleReason: null, connectedAt: null, lastVerifiedAt: null, lastError: null };
    }
    const freshness = credentialFreshness(broker, row.connected_at, row.expires_at, now);
    return {
      broker,
      connected: true,
      stale: !freshness.fresh,
      staleReason: freshness.reason,
      connectedAt: row.connected_at ?? null,
      lastVerifiedAt: row.last_verified_at ?? null,
      lastError: row.last_error ?? null,
    };
  });
}

export async function disconnectGuestCredential(userId: string, broker: GuestBroker): Promise<void> {
  const svc = createServiceClient();
  // Clear the ciphertext rather than only flagging the row: a disconnect should
  // leave nothing decryptable behind. The row survives so the history does.
  await svc
    .from("user_broker_credentials")
    .update({ ciphertext: "", fingerprint: null, disconnected_at: new Date().toISOString(), last_error: null })
    .eq("user_id", userId)
    .eq("broker", broker);
}
