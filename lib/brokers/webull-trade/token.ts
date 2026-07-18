// ============================================================================
// webull_trade — token lifecycle (spec §"Verified Trading API Facts").
// ----------------------------------------------------------------------------
// The Webull server marks a reusable token NORMAL, INVALID (after 15 consecutive
// days without an API call), or EXPIRED (initial 2FA verification not completed
// within 5 minutes). Kairos:
//   - tracks the last confirmed authenticated call;
//   - checks token status before order activity AFTER an idle interval;
//   - alerts before the 15-day boundary;
//   - fails CLOSED on INVALID / EXPIRED / UNKNOWN, and on a locally-computed idle
//     expiry, before any order submission;
//   - does NOT generate meaningless keepalive traffic just to hide an unused
//     credential.
//
// These are PURE functions over a passed-in WebullTokenRecord. No network call —
// the "check status" that would hit Webull is the caller's responsibility and is
// disabled with the rest of the live transport. Persistence of the record is
// wired in the live phase.
// ============================================================================

import type { TokenCheckResult, WebullTokenRecord } from "./types";

export const IDLE_INVALID_DAYS = 15;
export const VERIFY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
// Alert margin before the 15-day INVALID boundary.
export const IDLE_ALERT_MARGIN_DAYS = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

// True when the token has been idle long enough that we must re-check status with
// the server before trusting it (approaching the 15-day INVALID boundary).
export function idleDays(record: WebullTokenRecord, now: number = Date.now()): number | null {
  if (!record.lastAuthenticatedCallAt) return null;
  const last = Date.parse(record.lastAuthenticatedCallAt);
  if (!Number.isFinite(last)) return null;
  return (now - last) / DAY_MS;
}

// Should we raise a pre-expiry alert (approaching 15 idle days but not yet over)?
export function shouldAlertIdle(record: WebullTokenRecord, now: number = Date.now()): boolean {
  const d = idleDays(record, now);
  if (d === null) return false;
  return d >= IDLE_INVALID_DAYS - IDLE_ALERT_MARGIN_DAYS && d < IDLE_INVALID_DAYS;
}

// The single gate the order path calls. Fails CLOSED on anything but a NORMAL,
// non-idle-expired token. A missing last-call timestamp on a NORMAL token is
// treated as unknown-freshness and fails closed (we cannot prove it is in-date).
export function assertTokenUsableForOrder(
  record: WebullTokenRecord,
  now: number = Date.now(),
): TokenCheckResult {
  if (record.status === "INVALID") {
    return { usable: false, reason: "token INVALID (15+ idle days) — reconnect required", status: "INVALID" };
  }
  if (record.status === "EXPIRED") {
    return { usable: false, reason: "token EXPIRED (verify window missed) — reconnect required", status: "EXPIRED" };
  }
  if (record.status !== "NORMAL") {
    return { usable: false, reason: `token status ${record.status} — failing closed`, status: "UNKNOWN" };
  }
  // NORMAL: still fail closed if our OWN idle accounting says it should have
  // flipped to INVALID and we have not re-confirmed with the server.
  const d = idleDays(record, now);
  if (d === null) {
    return { usable: false, reason: "token freshness unknown (no last-call timestamp) — failing closed", status: "idle_expired" };
  }
  if (d >= IDLE_INVALID_DAYS) {
    return { usable: false, reason: `token idle ${d.toFixed(1)}d >= ${IDLE_INVALID_DAYS}d — must re-verify before order`, status: "idle_expired" };
  }
  return { usable: true };
}

// Was the initial 2FA verification completed inside the 5-minute window? Used at
// token acquisition; a freshly minted token whose verify window lapsed is EXPIRED.
export function isWithinVerifyWindow(mintedAt: string | null | undefined, verifiedAt: number, ): boolean {
  if (!mintedAt) return false;
  const minted = Date.parse(mintedAt);
  if (!Number.isFinite(minted)) return false;
  return verifiedAt - minted <= VERIFY_WINDOW_MS && verifiedAt >= minted;
}
