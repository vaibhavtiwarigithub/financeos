import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { OWNER_EMAIL } from "@/lib/auth/owner";

const ACCESS_ASSERTION_HEADER = "cf-access-jwt-assertion";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CloudflareAccessConfig = {
  teamDomain: string;
  audience: string;
  ownerUserId: string;
  ownerEmail?: string;
};

export type CloudflareAccessIdentity = {
  email: string;
  userId: string;
  subject: string;
};

type Jwks = Parameters<typeof jwtVerify>[1];
const remoteJwks = new Map<string, Jwks>();

export function cloudflareAccessConfig(env: Record<string, string | undefined> = process.env): CloudflareAccessConfig | null {
  const teamDomain = env.CLOUDFLARE_ACCESS_TEAM_DOMAIN?.trim().replace(/\/$/, "");
  const audience = env.CLOUDFLARE_ACCESS_AUD?.trim();
  const ownerUserId = env.CLOUDFLARE_ACCESS_OWNER_USER_ID?.trim();
  if (!teamDomain || !audience || !ownerUserId) return null;

  let parsed: URL;
  try { parsed = new URL(teamDomain); } catch { return null; }
  if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".cloudflareaccess.com") || parsed.pathname !== "/") return null;
  if (!UUID_RE.test(ownerUserId)) return null;
  return { teamDomain: parsed.origin, audience, ownerUserId, ownerEmail: OWNER_EMAIL };
}

function jwksFor(teamDomain: string): Jwks {
  let jwks = remoteJwks.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    remoteJwks.set(teamDomain, jwks);
  }
  return jwks;
}

function ownerIdentity(payload: JWTPayload, config: CloudflareAccessConfig): CloudflareAccessIdentity {
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  const subject = typeof payload.sub === "string" ? payload.sub : "";
  if (email !== (config.ownerEmail ?? OWNER_EMAIL).toLowerCase() || !subject) {
    throw new Error("Cloudflare Access identity is not the Kairos owner");
  }
  return { email, userId: config.ownerUserId, subject };
}

export async function verifyCloudflareAccessToken(
  token: string,
  config: CloudflareAccessConfig,
  jwks: Jwks = jwksFor(config.teamDomain),
): Promise<CloudflareAccessIdentity> {
  const { payload } = await jwtVerify(token, jwks, {
    issuer: config.teamDomain,
    audience: config.audience,
    algorithms: ["RS256"],
  });
  return ownerIdentity(payload, config);
}

export async function cloudflareAccessIdentityFromHeaders(
  headers: Pick<Headers, "get">,
  config = cloudflareAccessConfig(),
): Promise<CloudflareAccessIdentity | null> {
  const assertion = headers.get(ACCESS_ASSERTION_HEADER);
  if (!assertion) return null;
  if (!config) throw new Error("Cloudflare Access authentication is not configured");
  return verifyCloudflareAccessToken(assertion, config);
}

export function hasCloudflareAccessAssertion(headers: Pick<Headers, "has">): boolean {
  return headers.has(ACCESS_ASSERTION_HEADER);
}
