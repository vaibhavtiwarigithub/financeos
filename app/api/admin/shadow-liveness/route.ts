// Authorize before the shared, cookie-free collection-health reader.
import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { loadShadowCollectionHealth } from "@/lib/shadows/collection-health";
export const dynamic = "force-dynamic";
export async function GET() {
  const denied = await requireOwner();
  if (denied) return denied;
  return NextResponse.json(await loadShadowCollectionHealth(createServiceClient()));
}
