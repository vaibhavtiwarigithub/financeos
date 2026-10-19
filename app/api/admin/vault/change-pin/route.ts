import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { OWNER_EMAIL } from "@/lib/auth/owner"
import { hashPin } from "@/lib/vault-pin"

export const dynamic = "force-dynamic"

// Recovery uses the project's default Supabase magic-link template, which sends
// a clickable ConfirmationURL rather than a visible numeric OTP. The link
// returns through /auth/confirm and back to the locked Vault with a recovery
// marker. The write endpoint still requires the confirmed owner and a fresh
// Supabase sign-in, so a stale browser session cannot reset the Vault PIN.

const ADMIN_EMAIL = OWNER_EMAIL

export async function POST(req: NextRequest) {
  // Must be authenticated as admin
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL || !user.email_confirmed_at) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const body = await req.json()
  const { action } = body

  // Recovery does not require the old PIN. Send the default template's
  // clickable sign-in link only to the canonical owner address, returning to
  // the locked Vault after /auth/confirm has established the link's session.
  if (action === "send_recovery_link") {
    // Use the canonical Supabase Site URL as the safe default. The active
    // auth allow-list includes this host, not arbitrary Vercel preview hosts.
    const appBase = process.env.NEXT_PUBLIC_SITE_URL ?? "https://financeos-phi.vercel.app"
    const redirectTo = new URL("/auth/confirm", appBase)
    redirectTo.searchParams.set("next", "/dashboard/admin/vault?pin_recovery=1")
    const { error } = await sb.auth.signInWithOtp({
      email: OWNER_EMAIL,
      options: { shouldCreateUser: false, emailRedirectTo: redirectTo.toString() },
    })
    if (error) {
      return NextResponse.json({ error: "Could not send the reset link. Try again later." }, { status: 503 })
    }
    return NextResponse.json({ ok: true, message: `A one-time sign-in link was sent to ${OWNER_EMAIL}.` })
  }

  // The email link authenticates the owner. Only accept the PIN update within
  // 15 minutes of that sign-in; the canonical email/session check above remains
  // mandatory and the existing PIN is never returned or recovered.
  if (action === "verify_link_and_set") {
    const { new_pin } = body
    if (typeof new_pin !== "string" || !new_pin.trim()) {
      return NextResponse.json({ error: "new_pin required" }, { status: 400 })
    }
    if (new_pin.trim().length < 6 || new_pin.trim().length > 128) {
      return NextResponse.json({ error: "PIN must be between 6 and 128 characters" }, { status: 400 })
    }
    const lastSignIn = user.last_sign_in_at ? Date.parse(user.last_sign_in_at) : NaN
    const ageMs = Date.now() - lastSignIn
    if (!Number.isFinite(lastSignIn) || ageMs < -60_000 || ageMs > 15 * 60_000) {
      return NextResponse.json({ error: "Open the newest Vault recovery link from your email, then try again." }, { status: 403 })
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
