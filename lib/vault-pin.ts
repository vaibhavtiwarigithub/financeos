// Vault PIN hashing. RLS is access control, not encryption at rest, so the vault
// PIN must not be stored as recoverable plaintext. New PINs are stored as a
// salted scrypt hash (`s1$<saltHex>$<hashHex>`). Verification is backward-
// compatible with a legacy plaintext value (the env VAULT_PIN, or a pre-hash
// DB value) via a constant-time SHA-256 compare, so nothing gets locked out.
import { scryptSync, randomBytes, timingSafeEqual, createHash } from "crypto";

const PREFIX = "s1$";

export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  const dk = scryptSync(pin, salt, 32);
  return `${PREFIX}${salt.toString("hex")}$${dk.toString("hex")}`;
}

export function isHashedPin(stored: string | null | undefined): boolean {
  return typeof stored === "string" && stored.startsWith(PREFIX);
}

// Constant-time verify. `stored` may be a scrypt hash (new) or plaintext (legacy
// env / pre-hash DB value).
export function verifyPin(input: string | null | undefined, stored: string | null | undefined): boolean {
  if (input == null || stored == null) return false;
  if (isHashedPin(stored)) {
    const parts = stored.split("$"); // ["s1", saltHex, hashHex]
    const saltHex = parts[1], hashHex = parts[2];
    if (!saltHex || !hashHex) return false;
    let dk: Buffer;
    try { dk = scryptSync(input, Buffer.from(saltHex, "hex"), 32); }
    catch { return false; }
    const expected = Buffer.from(hashHex, "hex");
    return dk.length === expected.length && timingSafeEqual(dk, expected);
  }
  // Legacy plaintext — SHA-256 both sides so timingSafeEqual gets equal-length buffers.
  const a = createHash("sha256").update(input).digest();
  const b = createHash("sha256").update(stored).digest();
  return timingSafeEqual(a, b);
}
