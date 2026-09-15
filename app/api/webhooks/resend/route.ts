// Resend delivery webhook — turns "we accepted your message" into "it arrived".
//
// Resend returns 200 the moment it ACCEPTS a message. A dead mailbox bounces
// minutes later, out of band, and the only way to hear about it is here. Without
// this endpoint an invitation to a typo'd address looked identical to one that
// landed, and the access page showed it green.
//
// This endpoint is PUBLIC by necessity and is verified by signature on every
// request — see lib/email/resend-webhook.ts for why it fails closed.
//
// IT NEVER GRANTS OR REMOVES ACCESS. It writes only the three `undeliverable_*`
// columns, which are display state. A bounce is a fact about a mailbox, not a
// judgement about a person: revocation stays the owner's deliberate act in the
// app. Treating an unverified public endpoint as able to change who can sign in
// would be handing a stranger the access controls.
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { verifyResendWebhook, isHandledEvent } from "@/lib/email/resend-webhook";

export const dynamic = "force-dynamic";
export const runtime = "nodejs"; // node:crypto — HMAC verification

export async function POST(req: NextRequest) {
  // The signature covers the exact bytes, so read text and verify BEFORE parsing.
  const raw = await req.text();

  const verdict = verifyResendWebhook(
    raw,
    {
      id: req.headers.get("svix-id"),
      timestamp: req.headers.get("svix-timestamp"),
      signature: req.headers.get("svix-signature"),
    },
    process.env.RESEND_WEBHOOK_SECRET,
  );
  if (!verdict.ok) {
    // The reason goes in the response, not the log: it is diagnostic for whoever
    // is configuring the webhook and says nothing about the secret itself.
    return NextResponse.json({ error: `rejected: ${verdict.reason}` }, { status: 401 });
  }

  let event: any;
  try { event = JSON.parse(raw); } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }

  const type = event?.type;
  if (!isHandledEvent(type)) {
    // Unknown event types are Resend's business, not an error. 200 keeps them
    // from retrying something we will never act on.
    return NextResponse.json({ ok: true, ignored: String(type ?? "unknown") });
  }

  const data = event?.data ?? {};
  const emailId: string | null = typeof data?.email_id === "string" ? data.email_id : null;
  const recipients: string[] = (Array.isArray(data?.to) ? data.to : [data?.to])
    .filter((x: unknown): x is string => typeof x === "string" && x.length > 0)
    .map((x: string) => x.trim().toLowerCase());

  // A transient bounce is a full mailbox or a greylist, not a dead address. It
  // clears on its own, so recording it would put a red warning on a grant that
  // is fine by morning.
  const bounceType = String(data?.bounce?.type ?? "").toLowerCase();
  if (type === "email.bounced" && (bounceType === "transient" || bounceType === "soft")) {
    return NextResponse.json({ ok: true, ignored: "transient bounce" });
  }

  const svc = createServiceClient();

  // Every access email (invitation, sign-in link, revoke and delete notices) is
  // logged by message id in access_email_notices — including notices to accounts
  // that were deleted and so have no grant row below. Update only: a row exists
  // only if the app itself sent that message.
  if (emailId) {
    const { error: noticeError } = await svc.from("access_email_notices").update({
      status: type === "email.delivered" ? "delivered" : type === "email.complained" ? "complained" : "bounced",
      status_at: new Date().toISOString(),
      status_note: type === "email.delivered"
        ? null
        : String(data?.bounce?.message ?? data?.bounce?.subType ?? data?.reason ?? "").slice(0, 200) || null,
    }).eq("email_id", emailId);
    if (noticeError) console.warn(`[webhooks/resend] notice status not recorded: ${noticeError.message}`);
  }

  // Match by Resend's message id first — that ties the event to the exact send.
  // Address matching is the fallback, and it is the reason a bounce on ANY mail
  // we send a guest (the daily risk email too, not just the invitation) marks
  // them unreachable, which is correct: the question is whether we can reach
  // this person at all.
  let target: { user_id: string } | null = null;
  if (emailId) {
    const { data: byId } = await svc
      .from("app_user_roles").select("user_id").eq("invite_email_id", emailId).maybeSingle();
    target = (byId as any) ?? null;
  }
  if (!target && recipients.length) {
    const { data: byEmail } = await svc
      .from("app_user_roles").select("user_id").in("email", recipients).limit(1);
    target = ((byEmail as any[]) ?? [])[0] ?? null;
  }

  // No grant for this recipient — the owner's own newsletter, most likely.
  // Nothing to record, and nothing wrong.
  if (!target) return NextResponse.json({ ok: true, matched: false });

  const patch = type === "email.delivered"
    // Delivery is proof the address works now, so a stale warning must go.
    // Re-inviting clears it too; both paths exist because either can come first.
    ? { undeliverable_at: null, undeliverable_kind: null, undeliverable_note: null }
    : {
        undeliverable_at: new Date().toISOString(),
        undeliverable_kind: type === "email.complained" ? "complained" : "bounced",
        undeliverable_note: String(
          data?.bounce?.message ?? data?.bounce?.subType ?? data?.reason ?? "",
        ).slice(0, 200) || null,
      };

  const { error } = await svc.from("app_user_roles").update(patch).eq("user_id", target.user_id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, matched: true, event: type });
}
