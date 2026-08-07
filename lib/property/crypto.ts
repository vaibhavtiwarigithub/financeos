import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

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
