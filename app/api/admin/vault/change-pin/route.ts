import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { createHash, timingSafeEqual } from "crypto"

export const dynamic = "force-dynamic"

// Constant-time PIN check — SHA-256 both sides so timingSafeEqual gets
// equal-length buffers regardless of input length.
function pinMatches(input: string | null, active: string): boolean {
  if (input == null) return false
  const a = createHash("sha256").update(input).digest()
  const b = createHash("sha256").update(active).digest()
  return timingSafeEqual(a, b)
}

// Step 1: POST { action: "send_otp" }
//   → sends magic link / OTP to ADMIN_EMAIL via Supabase Auth
//   → requires X-Vault-Pin header (current PIN) to prove identity first
//
// Step 2: POST { action: "verify_and_set", otp: "123456", new_pin: "newpin" }
//   → verifies OTP via Supabase, stores new PIN in app_settings table
//   → new PIN takes priority over VAULT_PIN env var at runtime

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "vterminater@gmail.com"

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

async function verifyPin(pin: string): Promise<boolean> {
  const stored = await getStoredPin()
  const active = stored ?? getCurrentPin()
  if (!active) return false // fail closed — unconfigured vault has no valid PIN
  return pinMatches(pin, active)
}

export async function POST(req: NextRequest) {
  // Must be authenticated as admin
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const body = await req.json()
  const { action } = body

  // Step 1: verify current PIN then send OTP
  if (action === "send_otp") {
    const currentPin = req.headers.get("x-vault-pin")
    if (!currentPin || !(await verifyPin(currentPin))) {
      return NextResponse.json({ error: "Current PIN incorrect" }, { status: 403 })
    }

    const { error } = await sb.auth.signInWithOtp({
      email: ADMIN_EMAIL,
      options: { shouldCreateUser: false },
    })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ ok: true, message: `OTP sent to ${ADMIN_EMAIL}` })
  }

  // Step 2: verify OTP + set new PIN
  if (action === "verify_and_set") {
    const { otp, new_pin } = body
    if (!otp || !new_pin) {
      return NextResponse.json({ error: "otp and new_pin required" }, { status: 400 })
    }
    if (new_pin.length < 6) {
      return NextResponse.json({ error: "PIN must be at least 6 characters" }, { status: 400 })
    }

    // Verify OTP
    const { error: otpErr } = await sb.auth.verifyOtp({
      email: ADMIN_EMAIL,
      token: otp,
      type: "email",
    })
    if (otpErr) {
      return NextResponse.json({ error: "Invalid or expired OTP" }, { status: 403 })
    }

    // Store new PIN in DB (plaintext — protected by Supabase RLS + service role only)
    const svc = createServiceClient()
    const { error: dbErr } = await svc.from("app_settings").upsert({
      key: "vault_pin",
      value: new_pin,
      updated_at: new Date().toISOString(),
    }, { onConflict: "key" })

    if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 })

    return NextResponse.json({ ok: true, message: "PIN updated. New PIN active immediately." })
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 })
}
