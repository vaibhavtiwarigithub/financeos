import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  encryptCredential,
  decryptCredential,
  credentialFingerprint,
  credentialEncryptionAvailable,
  CredentialCipherError,
} from "@/lib/security/credential-cipher";

// These protect LIVE broker session tokens. The properties below are the reason
// the envelope format exists, so each is asserted rather than assumed.

const GOOD_KEY = "a".repeat(48);
const TOKEN = "kite-access-token-abc123";

describe("credential encryption", () => {
  beforeEach(() => { process.env.BROKER_CREDENTIAL_KEY = GOOD_KEY; });
  afterEach(() => { delete process.env.BROKER_CREDENTIAL_KEY; });

  it("round-trips a credential", () => {
    expect(decryptCredential(encryptCredential(TOKEN))).toBe(TOKEN);
  });

  it("never stores the plaintext", () => {
    expect(encryptCredential(TOKEN)).not.toContain(TOKEN);
  });

  it("produces a different ciphertext every time — no IV reuse", () => {
    // Reusing an IV under one key is the classic way to break GCM. Identical
    // plaintext must not yield identical stored bytes.
    const a = encryptCredential(TOKEN);
    const b = encryptCredential(TOKEN);
    expect(a).not.toBe(b);
    expect(decryptCredential(a)).toBe(TOKEN);
    expect(decryptCredential(b)).toBe(TOKEN);
  });

  it("carries a version prefix so a format change is detected, not guessed", () => {
    expect(encryptCredential(TOKEN).startsWith("v1.")).toBe(true);
    expect(() => decryptCredential("v2.a.b.c")).toThrow(CredentialCipherError);
    expect(() => decryptCredential("not-an-envelope")).toThrow(CredentialCipherError);
  });

  it("refuses a tampered ciphertext instead of returning altered plaintext", () => {
    const stored = encryptCredential(TOKEN);
    const parts = stored.split(".");
    // Flip a byte in the ciphertext segment.
    const data = Buffer.from(parts[3], "base64url");
    data[0] ^= 0xff;
    parts[3] = data.toString("base64url");
    expect(() => decryptCredential(parts.join("."))).toThrow(CredentialCipherError);
  });

  it("refuses a swapped auth tag", () => {
    const a = encryptCredential(TOKEN).split(".");
    const b = encryptCredential("another-token").split(".");
    expect(() => decryptCredential([a[0], a[1], b[2], a[3]].join("."))).toThrow(CredentialCipherError);
  });

  it("cannot be decrypted with a different key", () => {
    const stored = encryptCredential(TOKEN);
    process.env.BROKER_CREDENTIAL_KEY = "b".repeat(48);
    expect(() => decryptCredential(stored)).toThrow(CredentialCipherError);
  });

  it("does not leak WHY decryption failed", () => {
    // "wrong key" vs "tampered" is information an attacker would like.
    const stored = encryptCredential(TOKEN);
    process.env.BROKER_CREDENTIAL_KEY = "b".repeat(48);
    try {
      decryptCredential(stored);
      throw new Error("should have thrown");
    } catch (e: any) {
      expect(e.message).toBe("credential could not be decrypted");
    }
  });
});

describe("credential encryption — refuses to operate weakly", () => {
  afterEach(() => { delete process.env.BROKER_CREDENTIAL_KEY; });

  it("refuses when no key is configured", () => {
    delete process.env.BROKER_CREDENTIAL_KEY;
    expect(credentialEncryptionAvailable()).toBe(false);
    expect(() => encryptCredential(TOKEN)).toThrow(CredentialCipherError);
  });

  it("refuses a short key rather than accepting a weak one", () => {
    process.env.BROKER_CREDENTIAL_KEY = "tooshort";
    expect(credentialEncryptionAvailable()).toBe(false);
    expect(() => encryptCredential(TOKEN)).toThrow(/shorter than 32/);
  });

  it("refuses to encrypt an empty credential", () => {
    process.env.BROKER_CREDENTIAL_KEY = GOOD_KEY;
    expect(() => encryptCredential("")).toThrow(CredentialCipherError);
  });
});

describe("credential fingerprint", () => {
  it("is stable, short, and not the credential", () => {
    const fp = credentialFingerprint(TOKEN);
    expect(fp).toBe(credentialFingerprint(TOKEN));
    expect(fp).toHaveLength(12);
    expect(TOKEN).not.toContain(fp);
  });

  it("differs for different credentials", () => {
    expect(credentialFingerprint("a")).not.toBe(credentialFingerprint("b"));
  });
});
