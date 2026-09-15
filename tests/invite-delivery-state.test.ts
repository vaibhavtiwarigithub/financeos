import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { grantStatus, deliveryProblemText } from "@/lib/auth/grant-status";
import { verifyResendWebhook, isHandledEvent, TOLERANCE_SECONDS } from "@/lib/email/resend-webhook";

const ROOT = resolve(__dirname, "..");
const code = (p: string) => readFileSync(resolve(ROOT, p), "utf8").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
const ROUTE = code("app/api/admin/access/route.ts");
const HOOK = code("app/api/webhooks/resend/route.ts");
const PAGE = code("app/dashboard/admin/access/page.tsx");

const base = {
  revoked_at: null, confirmed_at: null,
  undeliverable_at: null, undeliverable_kind: null, undeliverable_note: null,
};

// The defect: an invitation to a mistyped address was written as a grant and
// rendered green "Active", because the only thing the page knew was whether the
// grant had been revoked. These are the states that must stay distinguishable.
describe("grant status — an unaccepted invite is not access", () => {
  it("a sent-but-unopened invitation is pending, not active", () => {
    const s = grantStatus(base);
    expect(s.state).toBe("pending");
    expect(s.accepted).toBe(false);
    expect(s.canSignIn).toBe(false);
    expect(s.tone).not.toBe("good");
  });

  it("acceptance comes from confirmed_at, and only then is it active", () => {
    const s = grantStatus({ ...base, confirmed_at: "2026-09-14T22:58:55Z" });
    expect(s.state).toBe("active");
    expect(s.canSignIn).toBe(true);
    expect(s.tone).toBe("good");
  });

  it("a bounced invitation reads as bounced, never as active", () => {
    const s = grantStatus({ ...base, undeliverable_at: "2026-09-15T01:00:00Z", undeliverable_kind: "bounced" });
    expect(s.state).toBe("pending");
    expect(s.canSignIn).toBe(false);
    expect(s.tone).toBe("bad");
    expect(s.label.toLowerCase()).toContain("bounce");
  });

  it("a complaint is reported as a complaint, not as a dead mailbox", () => {
    const s = grantStatus({ ...base, undeliverable_at: "2026-09-15T01:00:00Z", undeliverable_kind: "complained" });
    expect(s.label.toLowerCase()).toContain("spam");
    expect(s.deliveryProblem?.kind).toBe("complained");
    expect(deliveryProblemText(s.deliveryProblem)).toContain("filtered");
  });

  it("revoked outranks every other state", () => {
    for (const extra of [{}, { confirmed_at: "2026-01-01T00:00:00Z" }, { undeliverable_at: "2026-01-01T00:00:00Z", undeliverable_kind: "bounced" }]) {
      const s = grantStatus({ ...base, ...extra, revoked_at: "2026-09-14T23:35:01Z" });
      expect(s.state).toBe("revoked");
      expect(s.canSignIn).toBe(false);
    }
  });

  // Delivery and access are separate axes ON PURPOSE. Collapsing them would
  // mean a guest who already uses the app looks locked out the day their
  // mailbox fills up.
  it("a bounce AFTER acceptance does not take access away", () => {
    const s = grantStatus({
      ...base, confirmed_at: "2026-09-14T22:58:55Z",
      undeliverable_at: "2026-09-20T00:00:00Z", undeliverable_kind: "bounced",
    });
    expect(s.state).toBe("active");
    expect(s.canSignIn).toBe(true);
    expect(s.deliveryProblem).not.toBeNull();
  });
});

// The webhook is public by necessity and writes what the owner reads as "can
// this person be reached". An unsigned caller must not be able to write it.
describe("resend webhook — fails closed", () => {
  const SECRET = "whsec_" + Buffer.from("kairos-test-secret-key-0123456789").toString("base64");
  const body = JSON.stringify({ type: "email.bounced", data: { email_id: "re_1" } });

  function sign(b: string, id = "msg_1", ts = String(Math.floor(Date.now() / 1000))) {
    const key = Buffer.from(SECRET.replace(/^whsec_/, ""), "base64");
    const sig = createHmac("sha256", key).update(`${id}.${ts}.${b}`).digest("base64");
    return { id, timestamp: ts, signature: `v1,${sig}` };
  }

  it("accepts a correctly signed request", () => {
    expect(verifyResendWebhook(body, sign(body), SECRET).ok).toBe(true);
  });

  it("rejects when no secret is configured — there is no dev bypass", () => {
    for (const s of [undefined, null, ""]) {
      expect(verifyResendWebhook(body, sign(body), s as any).ok).toBe(false);
    }
  });

  it("rejects a tampered body under a valid signature", () => {
    const headers = sign(body);
    const tampered = JSON.stringify({ type: "email.delivered", data: { email_id: "re_1" } });
    expect(verifyResendWebhook(tampered, headers, SECRET).ok).toBe(false);
  });

  it("rejects a signature made with a different secret", () => {
    const other = "whsec_" + Buffer.from("a-completely-different-secret-val").toString("base64");
    const key = Buffer.from(other.replace(/^whsec_/, ""), "base64");
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac("sha256", key).update(`msg_1.${ts}.${body}`).digest("base64");
    expect(verifyResendWebhook(body, { id: "msg_1", timestamp: ts, signature: `v1,${sig}` }, SECRET).ok).toBe(false);
  });

  it("rejects missing headers", () => {
    expect(verifyResendWebhook(body, { id: null, timestamp: "1", signature: "v1,x" }, SECRET).ok).toBe(false);
    expect(verifyResendWebhook(body, { id: "a", timestamp: null, signature: "v1,x" }, SECRET).ok).toBe(false);
    expect(verifyResendWebhook(body, { id: "a", timestamp: "1", signature: null }, SECRET).ok).toBe(false);
  });

  it("rejects a replayed request outside the tolerance, in both directions", () => {
    const now = Math.floor(Date.now() / 1000);
    const stale = String(now - TOLERANCE_SECONDS - 1);
    const future = String(now + TOLERANCE_SECONDS + 1);
    expect(verifyResendWebhook(body, sign(body, "msg_1", stale), SECRET, now).ok).toBe(false);
    expect(verifyResendWebhook(body, sign(body, "msg_1", future), SECRET, now).ok).toBe(false);
  });

  it("accepts a rotation window carrying two signatures", () => {
    const h = sign(body);
    const withOld = { ...h, signature: `v1,ZmFrZXNpZ25hdHVyZXZhbHVlAAAAAAAAAAAAAAAAAAA= ${h.signature}` };
    expect(verifyResendWebhook(body, withOld, SECRET).ok).toBe(true);
  });

  it("only reacts to delivery events it understands", () => {
    expect(isHandledEvent("email.bounced")).toBe(true);
    expect(isHandledEvent("email.delivered")).toBe(true);
    expect(isHandledEvent("email.complained")).toBe(true);
    expect(isHandledEvent("email.opened")).toBe(false);
    expect(isHandledEvent(undefined)).toBe(false);
  });
});

describe("the webhook never becomes an access-control path", () => {
  it("verifies before parsing the body", () => {
    // The signature covers exact bytes. Parsing first and re-serializing would
    // silently break verification, so the ORDER is load-bearing.
    // Anchor on the CALL SITE, not the name: `verifyResendWebhook` also appears
    // in the import at the top of the file, and matching that made this
    // assertion vacuously true no matter where the parse happened.
    const call = HOOK.indexOf("const verdict = verifyResendWebhook(");
    expect(call, "verification call site not found").toBeGreaterThan(-1);
    expect(call).toBeLessThan(HOOK.indexOf("JSON.parse"));
  });

  it("writes only delivery columns — never the role, the grant, or the revocation", () => {
    for (const forbidden of ["revoked_at", "revoked_by", 'role:', "granted_by", "auth.admin", "delete("]) {
      expect(HOOK.includes(forbidden), `webhook touches ${forbidden}`).toBe(false);
    }
    expect(HOOK.includes("undeliverable_at")).toBe(true);
  });

  it("does not create grants — it can only update rows that already exist", () => {
    expect(HOOK.includes("upsert("), "webhook can create a grant").toBe(false);
    expect(HOOK.includes("insert("), "webhook can create a grant").toBe(false);
  });
});

describe("the invite path records what a bounce needs, and the page tells the truth", () => {
  it("stores the provider message id so a bounce matches this exact send", () => {
    expect(ROUTE.includes("invite_email_id: sent.id")).toBe(true);
  });

  it("re-inviting clears a previous bounce", () => {
    expect(/undeliverable_at:\s*null/.test(ROUTE)).toBe(true);
    expect(/undeliverable_kind:\s*null/.test(ROUTE)).toBe(true);
  });

  it("acceptance is read from Supabase, never mirrored into the grant table", () => {
    expect(ROUTE.includes("confirmed_at"), "route must read confirmed_at").toBe(true);
    // Writing it into app_user_roles would create a second, drifting authority.
    expect(/upsert\([\s\S]{0,900}confirmed_at/.test(ROUTE), "confirmed_at written into the grant row").toBe(false);
  });

  it("the page no longer claims a returning invite sends no email", () => {
    // It does send one — a recovery link. That string was simply false.
    expect(PAGE.includes("no email sent")).toBe(false);
  });

  it("the page counts people who can sign in, not rows that are un-revoked", () => {
    expect(PAGE.includes("g.can_sign_in")).toBe(true);
    expect(/filter\(\(g\) => g\.active\)\.length\} active/.test(PAGE), "still counting un-revoked as active").toBe(false);
  });
});
