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
import {
  accessLifecycleSubject,
  accessResendSubject,
  buildAccessLifecycleEmailHtml,
  buildAccessResendEmailHtml,
} from "@/lib/email/access-lifecycle-email";
import { grantStatus, deliveryProblemText } from "@/lib/auth/grant-status";
import { buildEmailLink } from "@/lib/auth/email-link";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;

  const svc = createServiceClient();
  const { data, error } = await svc
    .from("app_user_roles")
    .select(
      "user_id, email, role, granted_at, granted_by, revoked_at, revoked_by, note, " +
      "invite_sent_at, undeliverable_at, undeliverable_kind, undeliverable_note",
    )
    .order("granted_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // WHY THIS EXTRA LOOKUP.
  //
  // A grant row proves the owner INVITED someone. It does not prove they ever
  // accepted, and this page used to render every un-revoked grant as a green
  // "Active" — so an invitation to a mistyped address, which nobody received
  // and nobody can act on, looked exactly like a person with access.
  //
  // Acceptance is `auth.users.confirmed_at`. It is READ here and deliberately
  // not mirrored into `app_user_roles`: Supabase owns that fact, and a copy
  // would go stale the moment someone accepts.
  const confirmedAt = await confirmedAtByUserId(svc);

  // Recent access emails and what happened to each, including notices to
  // accounts that no longer exist. Display only; a read failure hides the list.
  const { data: noticeRows, error: noticeError } = await svc
    .from("access_email_notices")
    .select("email_id, recipient, kind, sent_at, status, status_at, status_note")
    .order("sent_at", { ascending: false })
    .limit(20);
  if (noticeError) console.warn(`[admin/access] notice log unavailable: ${noticeError.message}`);

  return NextResponse.json({
    owner: { email: OWNER_EMAIL, access: describeRoleAccess("owner") },
    viewer_access: describeRoleAccess("viewer"),
    viewer_pages: VIEWER_PAGES,
    notices: noticeError ? [] : (noticeRows ?? []),
    grants: (data ?? []).map((g: any) => {
      const status = grantStatus({
        revoked_at: g.revoked_at,
        confirmed_at: confirmedAt.get(g.user_id) ?? null,
        undeliverable_at: g.undeliverable_at,
        undeliverable_kind: g.undeliverable_kind,
        undeliverable_note: g.undeliverable_note,
      });
      return {
        ...g,
        // `active` is kept, unchanged, so nothing reading the old shape breaks.
        // It answers "not revoked" — which is NOT the same as "has access", and
        // treating it as the latter is the bug this change fixes.
        active: !g.revoked_at,
        status: status.state,
        accepted: status.accepted,
        can_sign_in: status.canSignIn,
        status_label: status.label,
        status_tone: status.tone,
        delivery_problem: deliveryProblemText(status.deliveryProblem),
      };
    }),
  });
}

/**
 * user_id -> confirmed_at for every auth user, via the bounded admin listing.
 *
 * One pass for the whole page rather than a lookup per grant: the guest list is
 * a handful of people and the listing is paged anyway.
 */
async function confirmedAtByUserId(svc: any): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await svc.auth.admin.listUsers({ page, perPage: 200 });
    if (error || !data?.users?.length) return out;
    for (const u of data.users) out.set(u.id, (u as any).confirmed_at ?? (u as any).email_confirmed_at ?? null);
    if (data.users.length < 200) return out;
  }
  return out;
}

export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }

  const action = String(body?.action ?? "");

  if (action === "invite") return invite(body, req);
  if (action === "resend") return resendAccess(body, req);

  const userId = String(body?.user_id ?? "").trim();
  if (!userId) return NextResponse.json({ error: "user_id required" }, { status: 400 });
  if (![
    "revoke", "restore", "delete",
  ].includes(action)) {
    return NextResponse.json({ error: "action must be invite|resend|revoke|restore|delete" }, { status: 400 });
  }

  const svc = createServiceClient();
  if (action === "delete") return deleteViewerAccount(svc, userId, body);
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

  if (action !== "revoke") {
    return NextResponse.json({ ok: true, action, grant: { ...data, active: !data.revoked_at } });
  }

  // Security takes precedence over delivery: access is already revoked even if
  // Resend is temporarily unavailable. The response makes a failed notice loud
  // instead of quietly claiming that the recipient was told.
  const delivery = await sendLifecycleNotice({
    kind: "revoked",
    recipientEmail: String((data as any).email),
  });
  if (delivery.ok) await recordNotice(svc, delivery.id, String((data as any).email), "revoked");
  return NextResponse.json({
    ok: true,
    action,
    grant: { ...data, active: false },
    email_sent: delivery.ok,
    email_error: delivery.ok ? undefined : delivery.error,
  });
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
  // `/reset-password` is the landing page. The mailed link is the APP's own URL
  // carrying Supabase's hashed token, and the page verifies it itself. It used
  // to be Supabase's `action_link`, whose hash tokens the PKCE browser client
  // ignores: a page that trusted "any session" then changed the password of
  // whoever was already signed in — the owner (production, 2026-09-15).
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
  const actionLink: string | null = buildEmailLink(base, "/reset-password", (linkData as any)?.properties);

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
    : await provider.send(message)
        .then(() => ({ ok: true as const, error: undefined, id: undefined as string | undefined }))
        .catch((e: any) => ({ ok: false as const, error: String(e?.message ?? e), id: undefined }));

  if (!sent.ok) {
    return NextResponse.json(
      { error: `invitation email could not be sent: ${String(sent.error ?? "unknown").slice(0, 200)}. No access was granted.` },
      { status: 502 },
    );
  }

  // Record WHICH message this was, so a bounce arriving minutes later at
  // /api/webhooks/resend can be matched to this exact grant instead of guessed
  // at by recipient address. Acceptance is never written here — that is
  // `auth.users.confirmed_at`, and it belongs to Supabase.
  //
  // Clearing `undeliverable_*` is the point of re-inviting a bounced address:
  // the owner fixed the typo or the mailbox came back, and a fresh send must
  // not inherit the old red warning. A delivery webhook clears it too; either
  // can arrive first.
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
      invite_email_id: sent.id ?? null,
      invite_sent_at: new Date().toISOString(),
      undeliverable_at: null,
      undeliverable_kind: null,
      undeliverable_note: null,
    },
    { onConflict: "user_id" },
  );
  if (grantError) return NextResponse.json({ error: grantError.message }, { status: 500 });
  await recordNotice(svc, sent.id, email, "invite");

  return NextResponse.json({
    ok: true,
    action: "invite",
    email,
    invited_new_account: !returning,
    // The email has been ACCEPTED by the provider, which is not the same as
    // delivered and nowhere near accepted by the recipient. The caller must not
    // report this as "they now have access".
    email_accepted_by_provider: true,
    awaiting_acceptance: true,
    access: describeRoleAccess("viewer"),
  });
}

/** Send a fresh one-time sign-in link to an already active viewer. */
async function resendAccess(body: any, req: NextRequest): Promise<NextResponse> {
  const userId = String(body?.user_id ?? "").trim();
  if (!userId) return NextResponse.json({ error: "user_id required" }, { status: 400 });
  const svc = createServiceClient();
  const { data: grant, error } = await svc.from("app_user_roles")
    .select("user_id,email,revoked_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!grant) return NextResponse.json({ error: "grant not found" }, { status: 404 });
  if ((grant as any).revoked_at) return NextResponse.json({ error: "restore access before sending a sign-in email" }, { status: 409 });
  if (!(await emailDeliveryAvailable())) return NextResponse.json({ error: "email is not configured" }, { status: 503 });

  const base = process.env.APP_BASE_URL || req.nextUrl.origin;
  const redirectTo = `${base.replace(/\/+$/, "")}/dashboard/portfolio`;
  const { data: linkData, error: linkError } = await svc.auth.admin.generateLink({
    type: "magiclink", email: (grant as any).email, options: { redirectTo },
  } as any);
  // Lands on /auth/confirm, which signs in as THIS viewer even if the browser
  // holds another session, then continues to the portfolio.
  const actionLink = buildEmailLink(base, "/auth/confirm", (linkData as any)?.properties, "/dashboard/portfolio");
  if (!actionLink) return NextResponse.json({ error: `could not generate sign-in link: ${linkError?.message ?? "unknown"}` }, { status: 502 });

  const provider = getEmailProvider();
  const sent = provider.sendChecked
    ? await provider.sendChecked({
      from: process.env.EMAIL_FROM || "Kairos <onboarding@resend.dev>",
      to: (grant as any).email,
      subject: accessResendSubject(),
      html: buildAccessResendEmailHtml({ actionLink, recipientEmail: (grant as any).email, ownerEmail: OWNER_EMAIL }),
    })
    : { ok: false, error: "configured email provider cannot confirm delivery" };
  if (!sent.ok) return NextResponse.json({ error: `access email could not be sent: ${String(sent.error ?? "unknown").slice(0, 200)}` }, { status: 502 });
  await recordNotice(svc, (sent as { id?: string }).id, String((grant as any).email), "resend");
  return NextResponse.json({ ok: true, action: "resend", email: (grant as any).email, email_sent: true });
}

/**
 * Log an access email Resend accepted, keyed by its message id, so the webhook
 * can later record delivered / bounced / reported-as-spam. Accepted is not
 * delivered: a deletion notice was accepted and landed in spam (2026-09-15).
 * A separate table because deleting an account cascades its grant row away.
 * Never blocks or fails the access action it describes.
 */
async function recordNotice(
  svc: any,
  emailId: string | undefined,
  recipient: string,
  kind: "invite" | "resend" | "revoked" | "deleted",
): Promise<void> {
  if (!emailId) return;
  const { error } = await svc.from("access_email_notices")
    .insert({ email_id: emailId, recipient: recipient.toLowerCase(), kind });
  if (error) console.warn(`[admin/access] could not record ${kind} email ${emailId}: ${error.message}`);
}

async function sendLifecycleNotice(input: { kind: "revoked" | "deleted"; recipientEmail: string }): Promise<{ ok: boolean; error?: string; id?: string }> {
  if (!(await emailDeliveryAvailable())) return { ok: false, error: "email is not configured" };
  const provider = getEmailProvider();
  if (!provider.sendChecked) return { ok: false, error: "configured email provider cannot confirm delivery" };
  return provider.sendChecked({
    from: process.env.EMAIL_FROM || "Kairos <onboarding@resend.dev>",
    to: input.recipientEmail,
    subject: accessLifecycleSubject(input.kind),
    html: buildAccessLifecycleEmailHtml({ ...input, ownerEmail: OWNER_EMAIL }),
  });
}

async function deleteViewerAccount(svc: any, userId: string, body: any): Promise<NextResponse> {
  const { data: grant, error } = await svc.from("app_user_roles")
    .select("user_id,email,revoked_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!grant) return NextResponse.json({ error: "grant not found" }, { status: 404 });
  const email = String((grant as any).email ?? "").toLowerCase();
  if (String(body?.confirmation ?? "") !== `DELETE ${email}`) {
    return NextResponse.json({ error: `confirmation must equal DELETE ${email}` }, { status: 400 });
  }

  // Revoke first, so even a deletion failure cannot leave a working viewer.
  await svc.from("app_user_roles").update({ revoked_at: new Date().toISOString(), revoked_by: OWNER_EMAIL })
    .eq("user_id", userId).is("revoked_at", null);
  const { error: deleteError } = await svc.auth.admin.deleteUser(userId);
  if (deleteError) {
    return NextResponse.json({ error: `account was revoked but could not be deleted: ${deleteError.message}` }, { status: 502 });
  }
  const delivery = await sendLifecycleNotice({ kind: "deleted", recipientEmail: email });
  if (delivery.ok) await recordNotice(svc, delivery.id, email, "deleted");
  return NextResponse.json({ ok: true, action: "delete", email, email_sent: delivery.ok, email_error: delivery.ok ? undefined : delivery.error });
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
