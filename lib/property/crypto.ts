import "server-only";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

const VERSION = "v1";

function key(): Buffer {
  const raw = process.env.PROPERTY_DATA_ENCRYPTION_KEY;
  if (!raw) throw new Error("PROPERTY_DATA_ENCRYPTION_KEY is not configured");
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length !== 32) throw new Error("PROPERTY_DATA_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  return decoded;
}

export function propertyEncryptionReady(): boolean {
  try { key(); return true; } catch { return false; }
}

export function encryptPropertyPayload(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptPropertyPayload<T>(sealed: string): T {
  const [version, ivRaw, tagRaw, ciphertextRaw] = sealed.split(".");
  if (version !== VERSION || !ivRaw || !tagRaw || !ciphertextRaw) throw new Error("Unsupported encrypted property payload");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextRaw, "base64url")), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

export function propertyContentHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Stable private lookup key for public-record identifiers and addresses.
 *
 * Plain SHA-256 is not sufficient for addresses or parcel numbers: both have a
 * small, enumerable input space and can be recovered with a dictionary attack.
 * A domain-separated HMAC stays joinable across releases without storing the
 * original identifier. The bulk worker receives the same master key through a
 * GitHub Actions secret.
 */
export function propertyLookupKey(domain: "parcel" | "address", value: string): string {
  const normalized = value.trim().toUpperCase().replace(/\s+/g, " ");
  if (!normalized) throw new Error("Property lookup value cannot be empty");
  return createHmac("sha256", key()).update(`property:${domain}:v1\0${normalized}`, "utf8").digest("hex");
}
