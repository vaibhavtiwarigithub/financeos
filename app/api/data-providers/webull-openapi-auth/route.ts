import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import { verifyPin } from "@/lib/vault-pin";
import { callWebullTokenApi } from "@/lib/data/webull-openapi-auth";
import { normalizeWebullCredential, type WebullOpenApiCredentials } from "@/lib/data/webull-openapi-preflight";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

const PROVIDER = "webull_openapi";
const ACTIVE_KEY = "WEBULL_OPENAPI_ACCESS_TOKEN";
const PENDING_KEY = "WEBULL_OPENAPI_PENDING_TOKEN";

async function readVault(svc: any, keyName: string): Promise<string | null> {
  try {
    const { data, error } = await svc.from("api_key_vault").select("key_value").eq("provider", PROVIDER).eq("key_name", keyName).maybeSingle();
    return !error && typeof data?.key_value === "string" ? normalizeWebullCredential(data.key_value) : null;
  } catch { return null; }
}

async function readActivePin(svc: any): Promise<string | null> {
  try {
    const { data } = await svc.from("app_settings").select("value").eq("key", "vault_pin").maybeSingle();
    return data?.value ?? process.env.VAULT_PIN ?? null;
  } catch { return process.env.VAULT_PIN ?? null; }
}

async function writeVault(svc: any, keyName: string, value: string, enabled: boolean, notes: string): Promise<boolean> {
  const { error } = await svc.from("api_key_vault").upsert({
    key_name: keyName,
    key_value: value,
    provider: PROVIDER,
    display_name: keyName === PENDING_KEY ? "Webull OpenAPI pending 2FA token" : "Webull OpenAPI access token",
    model_id: null,
    tasks_suitable: ["market_data"],
    cost_per_1m_input: 0,
    cost_per_1m_output: 0,
    enabled,
    notes,
    updated_at: new Date().toISOString(),
  }, { onConflict: "key_name" });
  return !error;
}

async function deleteVault(svc: any, keyName: string): Promise<boolean> {
  const { error } = await svc.from("api_key_vault").delete().eq("provider", PROVIDER).eq("key_name", keyName);
  return !error;
}

async function credentials(svc: any): Promise<WebullOpenApiCredentials> {
  const [vaultAppKey, vaultAppSecret] = await Promise.all([
    readVault(svc, "WEBULL_OPENAPI_APP_KEY"),
    readVault(svc, "WEBULL_OPENAPI_APP_SECRET"),
  ]);
  return {
    appKey: normalizeWebullCredential(process.env.WEBULL_OPENAPI_APP_KEY) ?? normalizeWebullCredential(process.env.WEBULL_APP_KEY) ?? vaultAppKey,
    appSecret: normalizeWebullCredential(process.env.WEBULL_OPENAPI_APP_SECRET) ?? normalizeWebullCredential(process.env.WEBULL_APP_SECRET) ?? vaultAppSecret,
    accessToken: null,
  };
}

function responseStatus(result: { state: string }): number {
  if (result.state === "token_status") return 200;
  if (result.state === "credentials_missing" || result.state === "token_required") return 409;
  if (result.state === "http_rejected") return 502;
  return 502;
}

export async function POST(req: NextRequest) {
  const denied = await requireOwner();
  if (denied) return denied;
  const svc = createServiceClient();
  const pin = req.headers.get("x-vault-pin");
  const activePin = await readActivePin(svc);
  if (!activePin) return NextResponse.json({ state: "vault_unconfigured" }, { status: 503 });
  if (!pin || !verifyPin(pin, activePin)) return NextResponse.json({ state: "vault_locked" }, { status: 403 });

  let body: { action?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ state: "invalid_request" }, { status: 400 }); }
  const action = body.action;
  if (action !== "create" && action !== "check") return NextResponse.json({ state: "invalid_request" }, { status: 400 });

  if (action === "create") {
    const pending = await readVault(svc, PENDING_KEY);
    if (pending) return NextResponse.json({ state: "verification_pending", instruction: "Approve the latest OpenAPI verification in the Webull app, then check status." });
    const result = await callWebullTokenApi("create", await credentials(svc));
    if (result.state === "token_status") {
      if (result.status === "PENDING") {
        if (!await writeVault(svc, PENDING_KEY, result.token!, false, `Webull 2FA verification pending; expires ${new Date(result.expiresAt!).toISOString()}.`)) {
          return NextResponse.json({ state: "vault_write_failed" }, { status: 500 });
        }
        return NextResponse.json({ state: "verification_pending", expiresAt: new Date(result.expiresAt!).toISOString(), instruction: "Open Webull app → Menu → Messages → OpenAPI Notifications, approve the request, enter the SMS code there, then return and check status." });
      }
      if (result.status === "NORMAL") {
        if (!await writeVault(svc, ACTIVE_KEY, result.token!, true, "Webull OpenAPI access token; created and immediately active.")) return NextResponse.json({ state: "vault_write_failed" }, { status: 500 });
        return NextResponse.json({ state: "token_active", expiresAt: new Date(result.expiresAt!).toISOString() });
      }
      return NextResponse.json({ state: "token_not_usable", tokenStatus: result.status }, { status: 502 });
    }
    return NextResponse.json(result, { status: responseStatus(result) });
  }

  const pending = await readVault(svc, PENDING_KEY);
  const active = pending ? null : normalizeWebullCredential(process.env.WEBULL_OPENAPI_ACCESS_TOKEN) ?? await readVault(svc, ACTIVE_KEY);
  const token = pending ?? active;
  if (!token) return NextResponse.json({ state: "no_token_to_check" }, { status: 409 });
  const result = await callWebullTokenApi("check", { ...(await credentials(svc)), accessToken: token });
  if (result.state === "token_status") {
    if (result.status === "NORMAL") {
      if (pending && !await writeVault(svc, ACTIVE_KEY, token, true, "Webull OpenAPI access token; verified NORMAL.")) return NextResponse.json({ state: "vault_write_failed" }, { status: 500 });
      if (pending && !await deleteVault(svc, PENDING_KEY)) return NextResponse.json({ state: "vault_write_failed" }, { status: 500 });
      return NextResponse.json({ state: "token_active" });
    }
    if (result.status === "EXPIRED" || result.status === "INVALID") {
      if (pending) await deleteVault(svc, PENDING_KEY);
      else await deleteVault(svc, ACTIVE_KEY);
      return NextResponse.json({ state: result.status === "EXPIRED" ? "token_expired" : "token_invalid" });
    }
    return NextResponse.json({ state: "verification_pending", tokenStatus: result.status, instruction: "Complete verification in the Webull app, then check again." });
  }
  return NextResponse.json(result, { status: responseStatus(result) });
}
