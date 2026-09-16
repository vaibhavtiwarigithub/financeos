import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const sendMail = vi.fn();
vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail }) },
}));

import { SmtpEmailProvider } from "@/lib/providers/email/smtp";

const configure = () => {
  process.env.SMTP_HOST = "smtp.gmail.com";
  process.env.SMTP_PORT = "465";
  process.env.SMTP_USER = "owner@example.com";
  process.env.SMTP_PASS = "app-password";
};
const unconfigure = () => {
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_PORT;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
};

const msg = { from: "Kairos <owner@example.com>", to: "guest@example.com", subject: "s", html: "<p>h</p>" };

beforeEach(() => { sendMail.mockReset(); unconfigure(); });
afterEach(() => { unconfigure(); });

// This provider was a stub whose send() only logged a warning and whose
// sendChecked did not exist. invite() falls back to
// `provider.send(...).then(() => ({ ok: true }))` when sendChecked is absent, so
// EMAIL_PROVIDER=smtp would have reported every invitation as sent, written the
// access grant, and mailed nothing.
describe("SmtpEmailProvider cannot report a silent failure as success", () => {
  it("implements sendChecked, so invite() never takes the assume-success fallback", () => {
    expect(typeof new SmtpEmailProvider().sendChecked).toBe("function");
  });

  it("reports not-configured instead of succeeding", async () => {
    const r = await new SmtpEmailProvider().sendChecked!(msg);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not configured/i);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("a recipient the server REFUSED is not a delivery", async () => {
    // nodemailer resolves as long as ONE address was accepted, listing refusals
    // in `rejected`. Reading only the resolve would grant access to someone the
    // mail server already refused to carry mail to.
    configure();
    sendMail.mockResolvedValue({ messageId: "<x@local>", accepted: [], rejected: ["guest@example.com"] });
    const r = await new SmtpEmailProvider().sendChecked!(msg);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("guest@example.com");
  });

  it("a thrown SMTP error is reported, never swallowed into success", async () => {
    configure();
    sendMail.mockRejectedValue(new Error("535 5.7.8 Username and Password not accepted"));
    const r = await new SmtpEmailProvider().sendChecked!(msg);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("535");
  });

  it("an accepted send keeps the message id, so a later bounce can be matched", async () => {
    configure();
    sendMail.mockResolvedValue({ messageId: "<abc@local>", accepted: ["guest@example.com"], rejected: [] });
    const r = await new SmtpEmailProvider().sendChecked!(msg);
    expect(r.ok).toBe(true);
    expect(r.id).toBe("<abc@local>");
  });

  it("send() still never throws, per the EmailProvider contract", async () => {
    configure();
    sendMail.mockRejectedValue(new Error("connection refused"));
    await expect(new SmtpEmailProvider().send(msg)).resolves.toBeUndefined();
  });

  it("isDeliverable matches isAvailable — SMTP has no vault behind it", async () => {
    const p = new SmtpEmailProvider();
    expect(await p.isDeliverable()).toBe(false);
    configure();
    expect(await new SmtpEmailProvider().isDeliverable()).toBe(true);
  });
});
