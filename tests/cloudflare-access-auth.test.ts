import { describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  cloudflareAccessConfig,
  cloudflareAccessIdentityFromHeaders,
  verifyCloudflareAccessToken,
  type CloudflareAccessConfig,
} from "@/lib/auth/cloudflare-access";

const config: CloudflareAccessConfig = {
  teamDomain: "https://kairos.cloudflareaccess.com",
  audience: "kairos-app-audience",
  ownerUserId: "a38bc4eb-62a7-4df4-8d2b-b09a2d34a291",
};
const keyPairPromise = generateKeyPair("RS256");
const keyId = "test-access-key";

async function testJwks() {
  const { publicKey } = await keyPairPromise;
  const jwk = await exportJWK(publicKey);
  return createLocalJWKSet({ keys: [{ ...jwk, kid: keyId, alg: "RS256", use: "sig" }] });
}

async function token(claims: Record<string, unknown> = {}, overrides: {
  issuer?: string;
  audience?: string;
  expiration?: string;
} = {}) {
  const { privateKey } = await keyPairPromise;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: keyId })
    .setIssuer(overrides.issuer ?? config.teamDomain)
    .setAudience(overrides.audience ?? config.audience)
    .setSubject("cloudflare-user-subject")
    .setIssuedAt()
    .setExpirationTime(overrides.expiration ?? "5m")
    .sign(privateKey);
}

describe("Cloudflare Access owner authentication", () => {
  it("maps a verified owner assertion to the stable Kairos user UUID", async () => {
    const assertion = await token({ email: "VTERMINATER@gmail.com", user_id: "untrusted-id" });
    const identity = await verifyCloudflareAccessToken(assertion, config, await testJwks());
    expect(identity).toEqual({
      email: "vterminater@gmail.com",
      userId: config.ownerUserId,
      subject: "cloudflare-user-subject",
    });
  });

  it("rejects invalid owner, issuer, audience, and expired assertions", async () => {
    const jwks = await testJwks();
    await expect(verifyCloudflareAccessToken(await token({ email: "intruder@example.com" }), config, jwks)).rejects.toThrow();
    await expect(verifyCloudflareAccessToken(await token({ email: "vterminater@gmail.com" }, { issuer: "https://attacker.cloudflareaccess.com" }), config, jwks)).rejects.toThrow();
    await expect(verifyCloudflareAccessToken(await token({ email: "vterminater@gmail.com" }, { audience: "another-app" }), config, jwks)).rejects.toThrow();
    await expect(verifyCloudflareAccessToken(await token({ email: "vterminater@gmail.com" }, { expiration: "-1s" }), config, jwks)).rejects.toThrow();
  });

  it("does not accept unsigned, malformed, or non-RS256 assertions", async () => {
    await expect(verifyCloudflareAccessToken("not-a-jwt", config, await testJwks())).rejects.toThrow();
  });

  it("returns no identity when the assertion header is absent and rejects it when not configured", async () => {
    expect(await cloudflareAccessIdentityFromHeaders(new Headers(), config)).toBeNull();
    await expect(cloudflareAccessIdentityFromHeaders(new Headers({ "cf-access-jwt-assertion": "present" }), null)).rejects.toThrow("not configured");
  });

  it("accepts only HTTPS Cloudflare Access team domains and a stable owner UUID", () => {
    expect(cloudflareAccessConfig({
      CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://muddy-sea-25c4.cloudflareaccess.com",
      CLOUDFLARE_ACCESS_AUD: "audience",
      CLOUDFLARE_ACCESS_OWNER_USER_ID: config.ownerUserId,
    })?.teamDomain).toBe("https://muddy-sea-25c4.cloudflareaccess.com");
    expect(cloudflareAccessConfig({
      CLOUDFLARE_ACCESS_TEAM_DOMAIN: "http://muddy-sea-25c4.cloudflareaccess.com",
      CLOUDFLARE_ACCESS_AUD: "audience",
      CLOUDFLARE_ACCESS_OWNER_USER_ID: config.ownerUserId,
    })).toBeNull();
    expect(cloudflareAccessConfig({
      CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://attacker.example.com",
      CLOUDFLARE_ACCESS_AUD: "audience",
      CLOUDFLARE_ACCESS_OWNER_USER_ID: config.ownerUserId,
    })).toBeNull();
    expect(cloudflareAccessConfig({
      CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://muddy-sea-25c4.cloudflareaccess.com",
      CLOUDFLARE_ACCESS_AUD: "audience",
      CLOUDFLARE_ACCESS_OWNER_USER_ID: "not-a-uuid",
    })).toBeNull();
  });
});
