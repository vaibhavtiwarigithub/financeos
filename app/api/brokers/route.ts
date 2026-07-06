import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { listBrokers } from "@/lib/brokers/registry";

export const dynamic = "force-dynamic";

export async function GET() {
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [us, india] = await Promise.all([
    Promise.all(listBrokers("us").map(async b => ({ id: b.id, envs: b.envs, configured: await b.isConfigured() }))),
    Promise.all(listBrokers("india").map(async b => ({ id: b.id, envs: b.envs, configured: await b.isConfigured() }))),
  ]);
  return NextResponse.json({ us, india });
}
