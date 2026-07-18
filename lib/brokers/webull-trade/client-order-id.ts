// ============================================================================
// webull_trade — stable client_order_id derivation (<=32 chars).
// ----------------------------------------------------------------------------
// The client_order_id is the idempotency key at the broker. It MUST be:
//   - deterministic for a given (intentId) so a retry of the SAME intent produces
//     the SAME id and cannot create a second order;
//   - <=32 chars and in the broker's allowed alphabet (alphanumeric);
//   - free of any account id, symbol PII, or secret.
//
// We derive it from a caller-supplied stable intent id (the execution-intent /
// idempotency key already reserved upstream) via a SHA-256, hex-encoded and
// truncated behind a short fixed prefix. Hex is alphanumeric ([0-9a-f]) so the id
// is broker-safe, and 29 hex chars carry ~116 bits — ample to avoid collisions.
// Same intent → same id; different intent → different id.
// ============================================================================

import { createHash } from "crypto";

const PREFIX = "kai"; // 3 chars — provenance marker, no account/symbol data
const MAX_LEN = 32;

export function deriveClientOrderId(intentId: string): string {
  if (typeof intentId !== "string" || intentId.trim().length === 0) {
    throw new Error("deriveClientOrderId: intentId is required");
  }
  const hex = createHash("sha256").update(intentId, "utf8").digest("hex");
  const body = hex.slice(0, MAX_LEN - PREFIX.length);
  return (PREFIX + body).slice(0, MAX_LEN);
}

// Validate an id meets the broker constraint (defense-in-depth for ids from any
// source, not just deriveClientOrderId).
export function isValidClientOrderId(id: string): boolean {
  return typeof id === "string" && id.length > 0 && id.length <= MAX_LEN && /^[A-Za-z0-9]+$/.test(id);
}
