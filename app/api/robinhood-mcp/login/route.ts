import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";

export const dynamic = "force-dynamic";

// This previously initiated a bespoke dynamic-client OAuth flow. Browser
// reproduction on 2026-09-17 showed Robinhood accepting consent then returning
// its generic error BEFORE this callback was reached. Its published setup is to
// connect the Trading MCP through the AI platform's MCP configuration, so fail
// closed here instead of repeatedly sending an owner through a broken consent.
export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const origin = req.nextUrl.origin;
  return NextResponse.redirect(`${origin}/dashboard/settings?tab=trading&rhmcp=platform_connect_required`);
}
