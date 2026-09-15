// Owner-only guest access management: who has access, and revoke/restore it.
//
// Revocation sets `revoked_at` rather than deleting, so the grant history
// survives. It takes effect at the NEXT request: middleware re-reads the grant
// on every request, so a revoked viewer is stopped at the edge and at every
// viewer-safe API route — not merely hidden from navigation.
import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import { OWNER_EMAIL } from "@/lib/auth/owner";
import { describeRoleAccess, VIEWER_PAGES } from "@/lib/auth/roles";
import { getEmailProvider, emailDeliveryAvailable } from "@/lib/providers/email";
import { buildInviteEmailHtml, inviteEmailSubject } from "@/lib/email/invite-email";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;

  const svc = createServiceClient();
  const { data, error } = await svc
    .from("app_user_roles")
    .select("user_id, email, role, granted_at, granted_by, revoked_at, revoked_by, note")
    .order("granted_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    owner: { email: OWNER_EMAIL, access: describeRoleAccess("owner") },
    viewer_access: describeRoleAccess("viewer"),
    viewer_pages: VIEWER_PAGES,
    grants: (data ?? []).map((g: any) => ({ ...g, active: !g.revoked_at })),
  });
}

export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }

  const action = String(body?.action ?? "");

  if (action === "invite") return invite(body, req);

  const userId = String(body?.user_id ?? "").trim();
  if (!userId) return NextResponse.json({ error: "user_id required" }, { status: 400 });
  if (!["revoke", "restore"].includes(action)) {
    return NextResponse.json({ error: "action must be invite|revoke|restore" }, { status: 400 });
  }

  const svc = createServiceClient();
  const patch = action === "revoke"
    ? { revoked_at: new Date().toISOString(), revoked_by: OWNER_EMAIL }
    : { revoked_at: null, revoked_by: null };

  const { data, error } = await svc
    .from("app_user_roles")
    .update(patch)
    .eq("user_id", userId)
    .select("user_id, email, revoked_at")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "grant not found" }, { status: 404 });

  return NextResponse.json({ ok: true, action, grant: { ...data, active: !data.revoked_at } });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Invite a viewer by email.
 *
 * The recipient sets their OWN password through Supabase's invitation flow. No
 * password is ever accepted, generated, stored, logged, or returned here.
 *
 * Access comes from the `app_user_roles` row written below, which is the only
 * authority for a non-owner role — the auth user alone grants nothing. So an
 * invite that half-completes fails CLOSED: the person can sign in but reaches
 * nothing until the grant exists.
 */
async function invite(body: any, req: NextRequest): Promise<NextResponse> {
  const email = String(body?.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "a valid email is required" }, { status: 400 });
  }
  if (email === OWNER_EMAIL.toLowerCase()) {
    return NextResponse.json({ error: "the owner already has full access" }, { status: 400 });
  }

  const svc = createServiceClient();
  const note = typeof body?.note === "string" ? body.note.slice(0, 200) : null;

  // WHERE THE INVITED PERSON LANDS.
  //
  // This was `inviteUserByEmail(email)` with no options, so Supabase fell back
  // to the project's Site URL — `http://localhost:3000`. Every invitation sent
  // pointed at the recipient's own machine, where nothing is running, so the
  // link was dead on arrival (observed 2026-09-14 on a real test invite:
  // "localhost is currently unreachable / ERR_CONNECTION_FAILED").
  //
  // `/reset-password` is the right landing page and needs no change: it gates
  // its form on a session being present, and a Supabase invite link establishes
  // one from its hash tokens exactly as a recovery link does. Its heading
  // already reads "Set new password", which is true for a first password too.
  //
  // NOTE FOR CONFIGURATION: Supabase validates redirectTo against the project's
  // allowed Redirect URLs and silently falls back to the Site URL when it does
  // not match. Passing this is therefore necessary but not sufficient — the
  // deployed origin must also be allowlisted in Authentication → URL
  // Configuration, or invitations will quietly point at localhost again.
  const base = process.env.APP_BASE_URL || req.nextUrl.origin;
  const redirectTo = `${base.replace(/\/+$/, "")}/reset-password`;

  // MINT the link, do not let Supabase SEND it.
  //
  // `inviteUserByEmail` mails Supabase's stock template: sender "Supabase Auth",
  // body "You've been invited to create an account" with no mention of what the
  // account is for, footer advertising Supabase. Someone being invited by a
  // person they know, to look at that person's portfolio, gets an unbranded
  // email from an unfamiliar sender and is asked to click a link in it. That is
  // both bland and a bad thing to teach people to do.
  //
  // `generateLink` returns the same one-time action link WITHOUT sending
  // anything, so the app delivers its own branded mail through the provider it
  // already uses for the daily risk email.
  const existingUserId = await findUserByEmail(svc, email);
  const returning = Boolean(existingUserId);

  const { data: linkData, error: linkError } = await svc.auth.admin.generateLink({
    // A person who already has an account cannot be "invited" again — Supabase
    // rejects it. A recovery link gets them back to the same set-password page,
    // which is what restoring a revoked viewer actually needs.
    type: returning ? "recovery" : "invite",
    email,
    options: { redirectTo },
  } as any);

  let userId: string | null = (linkData as any)?.user?.id ?? existingUserId ?? null;
  const actionLink: string | null = (linkData as any)?.properties?.action_link ?? null;

  if (!userId || !actionLink) {
    return NextResponse.json(
      { error: `invite failed: ${linkError?.message ?? "could not generate an invitation link"}` },
      { status: 502 },
    );
  }

  // The link is a credential: it sets a password. It is never logged and never
  // returned to the browser — it goes only into the email to its recipient.
  // Availability must be asked the way the SEND resolves it.
  //
  // `provider.isAvailable()` reads only `process.env.RESEND_API_KEY`, but the
  // Resend provider resolves from `api_key_vault` FIRST — and the key has lived
  // there since 2026-07-02. So this route reported "email is not configured" and
  // refused to invite anyone, while mail was working the whole time. A guard
  // that asks the wrong question fails closed on a healthy system, which is its
  // own kind of outage.
  if (!(await emailDeliveryAvailable())) {
    return NextResponse.json(
      { error: "email is not configured, so the invitation could not be sent. No access was granted." },
      { status: 503 },
    );
  }

  // `send` never throws and silently returns when it cannot deliver, which is
  // right for best-effort mail and useless here: the old try/catch could not
  // have caught anything. `sendChecked` reports the outcome, so a failed send
  // actually stops the grant.
  const provider = getEmailProvider();
  const message = {
    // Default to the sender the rest of this codebase actually sends with
    // (the daily newsletter and the briefing both use it). The previous default
    // was `noreply@kairos.app`, a domain nobody has verified in Resend, which
    // is why this returned 403. NOTE: `onboarding@resend.dev` is Resend's
    // shared testing sender and may only mail the Resend ACCOUNT OWNER's own
    // address — inviting anyone else needs a verified domain and EMAIL_FROM set
    // to an address on it.
    from: process.env.EMAIL_FROM || "Kairos <onboarding@resend.dev>",
    to: email,
    subject: inviteEmailSubject({ actionLink, inviterEmail: OWNER_EMAIL, note, returning }),
    html: buildInviteEmailHtml({ actionLink, inviterEmail: OWNER_EMAIL, note, returning }),
  };
  const sent = provider.sendChecked
    ? await provider.sendChecked(message)
    : await provider.send(message).then(() => ({ ok: true as const, error: undefined }))
        .catch((e: any) => ({ ok: false as const, error: String(e?.message ?? e) }));

  if (!sent.ok) {
    return NextResponse.json(
      { error: `invitation email could not be sent: ${String(sent.error ?? "unknown").slice(0, 200)}. No access was granted.` },
      { status: 502 },
    );
  }

  const { error: grantError } = await svc.from("app_user_roles").upsert(
    {
      user_id: userId,
      email,
      role: "viewer",
      granted_by: OWNER_EMAIL,
      granted_at: new Date().toISOString(),
      revoked_at: null,
      revoked_by: null,
      note,
    },
    { onConflict: "user_id" },
  );
  if (grantError) return NextResponse.json({ error: grantError.message }, { status: 500 });

  return NextResponse.json({
    ok: true,
    action: "invite",
    email,
    invited_new_account: !returning,
    access: describeRoleAccess("viewer"),
  });
}

/** Bounded lookup — this supabase-js version has no getUserByEmail. */
async function findUserByEmail(svc: any, email: string): Promise<string | null> {
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await svc.auth.admin.listUsers({ page, perPage: 200 });
    if (error || !data?.users?.length) return null;
    const hit = data.users.find((u: any) => String(u.email ?? "").toLowerCase() === email);
    if (hit) return hit.id;
    if (data.users.length < 200) return null;
  }
  return null;
}
