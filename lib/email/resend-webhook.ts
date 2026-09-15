// Signature verification for Resend's webhooks (Svix format).
//
// This endpoint is PUBLIC — it must be, because Resend calls it — and what it
// writes is shown on the owner's access page as a statement about whether a
// person can be reached. So an unsigned or wrongly-signed request must change
// nothing at all: otherwise anyone who guesses the URL can mark a real viewer's
// invitation "bounced", or clear a real bounce and restore the green "Active"
// that this whole change exists to stop being a lie.
//
// It FAILS CLOSED in every direction. No secret configured, missing headers, a
// signature that does not match, a replayed timestamp — all reject. There is no
// "skip verification in development" flag, because that flag is the bug.
import { createHmac, timingSafeEqual } from "node:crypto";

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: string };

/** Svix rejects anything older than this, and so do we — it is replay defence. */
export const TOLERANCE_SECONDS = 5 * 60;

export interface WebhookHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

function equalsConstantTime(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // timingSafeEqual throws on a length mismatch, which would itself leak length
  // through an exception path. Compare lengths first and return the same shape.
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * @param rawBody the EXACT bytes received. Re-serializing parsed JSON changes
 *   key order and whitespace, and the signature is over the bytes — so the
 *   caller must read the body as text and verify BEFORE parsing it.
 */
export function verifyResendWebhook(
  rawBody: string,
  headers: WebhookHeaders,
  secret: string | undefined | null,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): VerifyResult {
  if (!secret) return { ok: false, reason: "no RESEND_WEBHOOK_SECRET configured" };
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return { ok: false, reason: "missing svix headers" };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "bad svix-timestamp" };
  // Both directions: a far-future timestamp is as much a forgery signal as a
  // stale one, and accepting it would widen the replay window indefinitely.
  if (Math.abs(nowSeconds - ts) > TOLERANCE_SECONDS) return { ok: false, reason: "timestamp outside tolerance" };

  let key: Buffer;
  try {
    key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  } catch {
    return { ok: false, reason: "malformed secret" };
  }
  if (key.length === 0) return { ok: false, reason: "malformed secret" };

  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest("base64");

  // The header carries a space-separated list so a secret can be rotated with
  // both keys live. Any one match is enough.
  const presented = signature.split(" ").filter(Boolean);
  for (const part of presented) {
    const [version, value] = part.split(",", 2);
    if (version !== "v1" || !value) continue;
    if (equalsConstantTime(expected, value)) return { ok: true };
  }
  return { ok: false, reason: "signature mismatch" };
}

/** The Resend events worth reacting to. Everything else is ignored, not failed. */
export const HANDLED_EVENTS = ["email.bounced", "email.complained", "email.delivered"] as const;
export type HandledEvent = (typeof HANDLED_EVENTS)[number];

export function isHandledEvent(t: unknown): t is HandledEvent {
  return typeof t === "string" && (HANDLED_EVENTS as readonly string[]).includes(t);
}
