// Envelope encryption for per-user broker credentials.
//
// These are live broker session tokens. A database read alone must not be enough
// to use someone's brokerage account, so the ciphertext and the key are kept in
// different places: rows in Postgres, key in the server environment.
//
// AES-256-GCM, because it authenticates as well as encrypts — a tampered
// ciphertext fails to decrypt rather than silently yielding altered plaintext.
// Each record gets a fresh random IV; reusing an IV under one key is the classic
// way to destroy GCM's guarantees, so the IV is generated per call and never
// derived from anything.
//
// The stored form is `v1.<iv>.<authTag>.<ciphertext>`, all base64url. The version
// prefix exists so a future key rotation or algorithm change can be detected
// rather than guessed at.

import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto";

const VERSION = "v1";
const ALGO = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit IV — the size GCM is specified for
const KEY_ENV = "BROKER_CREDENTIAL_KEY";

export class CredentialCipherError extends Error {}

/**
 * The encryption key, derived from the env secret.
 *
 * SHA-256 gives a uniform 32 bytes from an operator-supplied string of any
 * length, so a short or non-hex secret cannot silently produce a weak or
 * wrong-length key. It is NOT a password KDF and is not meant to be: the input
 * is a machine-generated secret, not a human password.
 */
function key(): Buffer {
  const secret = process.env[KEY_ENV];
  if (!secret || secret.trim().length < 32) {
    // Fail loudly and identically whether missing or too short — a weak key must
    // never be silently accepted for live broker tokens.
    throw new CredentialCipherError(
      `${KEY_ENV} is missing or shorter than 32 characters — refusing to encrypt broker credentials with a weak key`,
    );
  }
  return createHash("sha256").update(secret, "utf8").digest();
}

/** True when the server is configured to hold credentials at all. */
export function credentialEncryptionAvailable(): boolean {
  try { key(); return true; } catch { return false; }
}

export function encryptCredential(plaintext: string): string {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new CredentialCipherError("refusing to encrypt an empty credential");
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    enc.toString("base64url"),
  ].join(".");
}

export function decryptCredential(stored: string): string {
  const parts = String(stored ?? "").split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new CredentialCipherError("stored credential is not in the expected v1 envelope format");
  }
  const [, ivB64, tagB64, dataB64] = parts;
  try {
    const decipher = createDecipheriv(ALGO, key(), Buffer.from(ivB64, "base64url"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch (err) {
    // Never echo the underlying error: it can distinguish "wrong key" from
    // "tampered ciphertext", which is information an attacker would like.
    if (err instanceof CredentialCipherError) throw err;
    throw new CredentialCipherError("credential could not be decrypted");
  }
}

/**
 * A non-reversible fingerprint, for logs and support questions.
 *
 * Lets an operator answer "is this the same token as yesterday?" without the
 * token ever appearing anywhere. Truncated so it cannot serve as an offline
 * verification oracle for a guessed plaintext.
 */
export function credentialFingerprint(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex").slice(0, 12);
}
