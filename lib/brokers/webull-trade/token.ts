import type { TokenCheckResult, WebullTokenRecord } from "./types";

export const IDLE_INVALID_DAYS = 15;
export const VERIFY_WINDOW_MS = 5 * 60 * 1000;
export const IDLE_ALERT_MARGIN_DAYS = 2;
export const MAX_SERVER_STATUS_AGE_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function idleDays(record: WebullTokenRecord, now: number = Date.now()): number | null {
  if (!record.lastAuthenticatedCallAt) return null;
  const last = Date.parse(record.lastAuthenticatedCallAt);
  if (!Number.isFinite(last) || last > now) return null;
  return (now - last) / DAY_MS;
}

export function shouldAlertIdle(record: WebullTokenRecord, now: number = Date.now()): boolean {
  const days = idleDays(record, now);
  return days !== null && days >= IDLE_INVALID_DAYS - IDLE_ALERT_MARGIN_DAYS && days < IDLE_INVALID_DAYS;
}

export function assertTokenUsableForOrder(record: WebullTokenRecord, now: number = Date.now()): TokenCheckResult {
  if (record.status === "INVALID") {
    return { usable: false, reason: "token INVALID (15+ idle days) - reconnect required", status: "INVALID" };
  }
  if (record.status === "EXPIRED") {
    return { usable: false, reason: "token EXPIRED - reconnect required", status: "EXPIRED" };
  }
  if (record.status === "PENDING") {
    return { usable: false, reason: "token PENDING - Webull app verification required", status: "PENDING" };
  }
  if (record.status !== "NORMAL") {
    return { usable: false, reason: `token status ${record.status} - failing closed`, status: "UNKNOWN" };
  }
  if (record.expiresAt) {
    const expires = Date.parse(record.expiresAt);
    if (!Number.isFinite(expires) || now >= expires) {
      return { usable: false, reason: "token expiry is invalid or has passed - failing closed", status: "EXPIRED" };
    }
  }
  if (!record.serverStatusCheckedAt) {
    return { usable: false, reason: "token server status was not confirmed before order - failing closed", status: "UNKNOWN" };
  }
  const checked = Date.parse(record.serverStatusCheckedAt);
  if (!Number.isFinite(checked) || checked > now || now - checked > MAX_SERVER_STATUS_AGE_MS) {
    return { usable: false, reason: "token server status confirmation is stale or invalid - failing closed", status: "UNKNOWN" };
  }
  const days = idleDays(record, now);
  if (days === null) {
    return { usable: false, reason: "token freshness unknown - failing closed", status: "idle_expired" };
  }
  if (days >= IDLE_INVALID_DAYS) {
    return { usable: false, reason: `token idle ${days.toFixed(1)}d - must re-verify before order`, status: "idle_expired" };
  }
  return { usable: true };
}

export function isWithinVerifyWindow(mintedAt: string | null | undefined, verifiedAt: number): boolean {
  if (!mintedAt) return false;
  const minted = Date.parse(mintedAt);
  return Number.isFinite(minted) && verifiedAt >= minted && verifiedAt - minted <= VERIFY_WINDOW_MS;
}
