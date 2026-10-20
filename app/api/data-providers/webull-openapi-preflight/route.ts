import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import { normalizeWebullCredential, runWebullOpenApiPreflight, type WebullOpenApiCredentials } from "@/lib/data/webull-openapi-preflight";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

const VAULT_PROVIDER = "webull_openapi";
const VAULT_NAMES = {
  appKey: "WEBULL_OPENAPI_APP_KEY",
  appSecret: "WEBULL_OPENAPI_APP_SECRET",
  accessToken: "WEBULL_OPENAPI_ACCESS_TOKEN",
} as const;

async function vaultValue(svc: ReturnType<typeof createServiceClient>, keyName: string): Promise<string | null> {
  try {
    const { data, error } = await svc.from("api_key_vault")
      .select("key_value")
      .eq("provider", VAULT_PROVIDER)
      .eq("key_name", keyName)
      .maybeSingle();
    if (error) return null;
    return normalizeWebullCredential(typeof (data as any)?.key_value === "string" ? (data as any).key_value : null);
  } catch { return null; }
}

async function resolveCredentials(svc: ReturnType<typeof createServiceClient>): Promise<WebullOpenApiCredentials> {
  const [vaultAppKey, vaultAppSecret, vaultToken] = await Promise.all([
    vaultValue(svc, VAULT_NAMES.appKey),
    vaultValue(svc, VAULT_NAMES.appSecret),
    vaultValue(svc, VAULT_NAMES.accessToken),
  ]);
  return {
    appKey: normalizeWebullCredential(process.env.WEBULL_OPENAPI_APP_KEY) ?? normalizeWebullCredential(process.env.WEBULL_APP_KEY) ?? vaultAppKey,
    appSecret: normalizeWebullCredential(process.env.WEBULL_OPENAPI_APP_SECRET) ?? normalizeWebullCredential(process.env.WEBULL_APP_SECRET) ?? vaultAppSecret,
    accessToken: normalizeWebullCredential(process.env.WEBULL_OPENAPI_ACCESS_TOKEN) ?? vaultToken,
  };
}

export async function POST() {
  const denied = await requireOwner();
  if (denied) return denied;
  const credentials = await resolveCredentials(createServiceClient());
  const result = await runWebullOpenApiPreflight(credentials);
  return NextResponse.json({
    ...result,
    checkedAt: new Date().toISOString(),
    provider: "Webull OpenAPI Market Data",
    scope: "one read-only AAPL US-stock snapshot; no account, order, score, or persistence access",
  }, { status: result.state === "snapshot_contract_valid" ? 200 : result.state === "access_token_required" || result.state === "credentials_missing" ? 409 : 502 });
}
