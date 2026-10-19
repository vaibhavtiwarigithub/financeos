import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { OWNER_EMAIL } from "@/lib/auth/owner"
import { verifyPin, hashPin } from "@/lib/vault-pin"

export const dynamic = "force-dynamic"

// Step 1: POST { action: "send_otp" | "send_recovery_otp" }
//   → normal PIN change requires the current PIN; recovery requires only the signed-in owner.
//
// Step 2: POST { action: "verify_and_set", otp: "123456", new_pin: "newpin" }
//   → verifies OTP via Supabase, stores new PIN in app_settings table
//   → new PIN takes priority over VAULT_PIN env var at runtime

const ADMIN_EMAIL = OWNER_EMAIL

// No hardcoded fallback — vault fails closed if neither a DB-stored PIN nor
// VAULT_PIN env is set (matches app/api/admin/vault/route.ts behavior).
function getCurrentPin(): string | null {
  return process.env.VAULT_PIN ?? null
}

async function getStoredPin(): Promise<string | null> {
  const svc = createServiceClient()
  const { data } = await svc.from("app_settings").select("value").eq("key", "vault_pin").single()
  return data?.value ?? null
}

async function checkCurrentPin(pin: string): Promise<boolean> {
  const stored = await getStoredPin()
  const active = stored ?? getCurrentPin()
  if (!active) return false // fail closed — unconfigured vault has no valid PIN
  return verifyPin(pin, active) // handles scrypt-hashed or legacy plaintext
}

export async function POST(req: NextRequest) {
  // Must be authenticated as admin
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL || !user.email_confirmed_at) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const body = await req.json()
  const { action } = body

  // Step 1: verify current PIN then send OTP
  if (action === "send_otp") {
    const currentPin = req.headers.get("x-vault-pin")
    if (!currentPin || !(await checkCurrentPin(currentPin))) {
      return NextResponse.json({ error: "Current PIN incorrect" }, { status: 403 })
    }

    const { error } = await sb.auth.signInWithOtp({
      email: ADMIN_EMAIL,
      options: { shouldCreateUser: false },
    })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ ok: true, message: `OTP sent to ${ADMIN_EMAIL}` })
  }

  // Recovery does not require the old PIN. The signed-in, confirmed owner is
  // checked above; Supabase sends its one-time code only to the fixed owner
  // address and enforces the project's OTP expiry and rate limits.
  if (action === "send_recovery_otp") {
    const { error } = await sb.auth.signInWithOtp({
      email: OWNER_EMAIL,
      options: { shouldCreateUser: false },
    })
    if (error) {
      return NextResponse.json({ error: "Could not send the reset code. Try again later." }, { status: 503 })
    }
    return NextResponse.json({ ok: true, message: `A one-time code was sent to ${OWNER_EMAIL}.` })
  }

  // Step 2: verify OTP + set new PIN
  if (action === "verify_and_set") {
    const { otp, new_pin } = body
    if (typeof otp !== "string" || !/^\d{6,8}$/.test(otp) || typeof new_pin !== "string" || !new_pin.trim()) {
      return NextResponse.json({ error: "otp and new_pin required" }, { status: 400 })
    }
    if (new_pin.trim().length < 6 || new_pin.trim().length > 128) {
      return NextResponse.json({ error: "PIN must be between 6 and 128 characters" }, { status: 400 })
    }

    // Verify OTP
    const { error: otpErr } = await sb.auth.verifyOtp({
      email: OWNER_EMAIL,
      token: otp.trim(),
      type: "email",
    })
    if (otpErr) {
      return NextResponse.json({ error: "Invalid or expired OTP" }, { status: 403 })
    }

    // Store new PIN in DB (plaintext — protected by Supabase RLS + service role only)
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
