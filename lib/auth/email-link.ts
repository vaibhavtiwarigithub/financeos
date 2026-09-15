// One-time email links (invite, password recovery, sign-in) and the session
// they are allowed to create.
//
// THE DEFECT THIS EXISTS FOR (production, 2026-09-15). The set-password page
// showed its form whenever `getSession()` returned ANY session, then called
// `updateUser({ password })`. The admin-minted invite link carried its tokens
// in the URL hash, which the PKCE browser client from @supabase/ssr does not
// read. So when the owner opened a viewer's invite link in a browser that was
// still signed in as the owner, nothing replaced the owner's session and the
// "new viewer password" was written to the OWNER's account. The viewer's
// account never got a password at all.
//
// The rule now: a link page acts only on the account the LINK proves. A session
// that was already in the browser never counts. Every link is verified on the
// page itself, which replaces whatever session was there.

export type EmailLinkType = "invite" | "recovery" | "magiclink";

/** Link types that may lead to choosing a password. A sign-in link may not. */
export const SET_PASSWORD_LINK_TYPES: readonly string[] = ["invite", "recovery"];
export const SIGN_IN_LINK_TYPES: readonly string[] = ["magiclink"];

export type ParsedEmailLink =
  | { kind: "otp"; tokenHash: string; type: string }
  | { kind: "code"; code: string }
  | { kind: "implicit"; accessToken: string; refreshToken: string; type: string | null }
  | { kind: "error"; message: string }
  | { kind: "none" };

export type LinkSessionResult =
  | { ok: true; userId: string; email: string }
  | { ok: false; reason: string };

/**
 * Server side: build the app's own link from `generateLink`'s properties.
 *
 * Supabase's `action_link` sends the browser through Supabase's verify endpoint
 * and back with tokens in the hash. `hashed_token` lets the page verify the link
 * itself with `verifyOtp`, which is what replaces a leftover session.
 * Returns null when Supabase did not return a token, so callers fail closed.
 */
export function buildEmailLink(
  base: string,
  path: string,
  properties: { hashed_token?: string | null; verification_type?: string | null } | null | undefined,
  next?: string,
): string | null {
  const token = properties?.hashed_token;
  const type = properties?.verification_type;
  if (!token || !type) return null;
  const params = new URLSearchParams({ token_hash: token, type });
  if (next) params.set("next", next);
  return `${base.replace(/\/+$/, "")}${path}?${params.toString()}`;
}

/** Read whichever link format arrived: our token link, a PKCE code, or Supabase's hash tokens. */
export function parseEmailLink(search: string, hash: string): ParsedEmailLink {
  const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const h = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);

  const tokenHash = q.get("token_hash");
  const type = q.get("type");
  if (tokenHash && type) return { kind: "otp", tokenHash, type };

  const code = q.get("code");
  if (code) return { kind: "code", code };

  const accessToken = h.get("access_token");
  const refreshToken = h.get("refresh_token");
  if (accessToken && refreshToken) return { kind: "implicit", accessToken, refreshToken, type: h.get("type") };

  // Supabase reports an expired or already-used link in the hash (or query).
  const message = h.get("error_description") ?? q.get("error_description");
  if (message) return { kind: "error", message: message.replace(/\+/g, " ") };

  return { kind: "none" };
}

/** Same-origin relative path only; mirrors app/auth/callback's open-redirect guard. */
export function safeNextPath(raw: string | null, fallback: string): string {
  return raw && /^\/(?![/\\])/.test(raw) && !raw.includes("@") ? raw : fallback;
}

type AuthLike = {
  auth: {
    verifyOtp: (p: { token_hash: string; type: any }) => Promise<{ data: { user: any; session: any }; error: any }>;
    exchangeCodeForSession: (code: string) => Promise<{ data: { user: any; session: any }; error: any }>;
    setSession: (p: { access_token: string; refresh_token: string }) => Promise<{ data: { user: any; session: any }; error: any }>;
  };
};

const EXPIRED = "This link is invalid, expired, or has already been used. Ask for a new email and open the newest link.";

/**
 * Browser side: create the session the link proves, replacing any session that
 * was already there. Never reads an existing session.
 */
export async function establishEmailLinkSession(
  supabase: AuthLike,
  link: ParsedEmailLink,
  allowedTypes: readonly string[],
): Promise<LinkSessionResult> {
  if (link.kind === "none") return { ok: false, reason: "This page only works from the link in an email. Open the newest email and click its button." };
  if (link.kind === "error") return { ok: false, reason: `${link.message}. Ask for a new email and open the newest link.` };

  let result: { data: { user: any; session: any }; error: any };
  if (link.kind === "otp") {
    if (!allowedTypes.includes(link.type)) return { ok: false, reason: "This link cannot be used on this page." };
    result = await supabase.auth.verifyOtp({ token_hash: link.tokenHash, type: link.type });
  } else if (link.kind === "implicit") {
    if (link.type && !allowedTypes.includes(link.type)) return { ok: false, reason: "This link cannot be used on this page." };
    result = await supabase.auth.setSession({ access_token: link.accessToken, refresh_token: link.refreshToken });
  } else {
    result = await supabase.auth.exchangeCodeForSession(link.code);
  }

  const user = result.data?.user ?? result.data?.session?.user ?? null;
  if (result.error || !user?.id || !user?.email) return { ok: false, reason: EXPIRED };
  return { ok: true, userId: String(user.id), email: String(user.email) };
}
