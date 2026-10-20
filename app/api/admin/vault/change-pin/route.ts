import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { OWNER_EMAIL } from "@/lib/auth/owner"
import { hashPin } from "@/lib/vault-pin"
import { emailDeliveryAvailable, getEmailProvider } from "@/lib/providers/email"
import { buildVaultPinRecoveryEmailHtml, vaultPinRecoverySubject } from "@/lib/email/vault-pin-recovery-email"

export const dynamic = "force-dynamic"

// Recovery uses a Supabase-generated recovery OTP delivered through Kairos'
// checked email provider. No clickable Supabase auth URL is sent, avoiding
// email-security scanners consuming the one-time token before the owner opens it.

const ADMIN_EMAIL = OWNER_EMAIL

export async function POST(req: NextRequest) {
  // Must be authenticated as admin
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL || !user.email_confirmed_at) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 })
  }
  const { action } = body

  // Recovery does not require the old PIN. Generate a Supabase recovery OTP,
  // then deliver it through the app's configured email provider. Using the
  // provider explicitly lets the owner receive a code without changing the
  // shared Supabase Magic Link template used by regular sign-in flows.
  if (action === "send_recovery_code") {
    if (!(await emailDeliveryAvailable())) {
      return NextResponse.json({ error: "Vault recovery email is not configured. Contact the app owner." }, { status: 503 })
    }
    const svc = createServiceClient()
    const { data, error } = await svc.auth.admin.generateLink({ type: "recovery", email: OWNER_EMAIL })
    const code = data?.properties?.email_otp
    if (error || typeof code !== "string" || !/^\d{6}$/.test(code)) {
      return NextResponse.json({ error: "Could not create a reset code. Try again later." }, { status: 503 })
    }

    const provider = getEmailProvider()
    if (!provider.sendChecked) {
      return NextResponse.json({ error: "The configured email provider cannot verify delivery." }, { status: 503 })
    }
    const sent = await provider.sendChecked({
      from: process.env.EMAIL_FROM || "Kairos <onboarding@resend.dev>",
      to: OWNER_EMAIL,
      subject: vaultPinRecoverySubject(),
      html: buildVaultPinRecoveryEmailHtml({ code, ownerEmail: OWNER_EMAIL }),
    })
    if (!sent.ok) {
      return NextResponse.json({ error: "Could not send the reset code. Check the email provider configuration and try again." }, { status: 503 })
    }
    return NextResponse.json({ ok: true, message: `A one-time reset code was sent to ${OWNER_EMAIL}.` })
  }

  // Supabase verifies OTP expiry/one-time use. Only the confirmed canonical
  // owner can update the Vault PIN; no old PIN or existing sign-in timestamp
  // is trusted, and only a salted hash is persisted.
  if (action === "verify_code_and_set") {
    const { new_pin, code } = body
    if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
      return NextResponse.json({ error: "Enter the six-digit code from the latest email." }, { status: 400 })
    }
    if (typeof new_pin !== "string" || !new_pin.trim()) {
      return NextResponse.json({ error: "new_pin required" }, { status: 400 })
    }
    if (new_pin.trim().length < 6 || new_pin.trim().length > 128) {
      return NextResponse.json({ error: "PIN must be between 6 and 128 characters" }, { status: 400 })
    }
    const { data: verified, error: verifyError } = await sb.auth.verifyOtp({
      email: OWNER_EMAIL,
      token: code,
      type: "recovery",
    })
    if (verifyError || verified.user?.email !== OWNER_EMAIL || !verified.user.email_confirmed_at) {
      return NextResponse.json({ error: "The code is invalid, expired, or already used. Request a new code and use the latest email." }, { status: 403 })
    }

    const svc = createServiceClient()
    // Store a salted scrypt HASH, never the recoverable plaintext PIN.
    const { error: dbErr } = await svc.from("app_settings").upsert({
      key: "vault_pin",
      value: hashPin(new_pin.trim()),
      updated_at: new Date().toISOString(),
    }, { onConflict: "key" })

    if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 })

    return NextResponse.json({ ok: true, message: "PIN updated. New PIN active immediately." })
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 })
}
