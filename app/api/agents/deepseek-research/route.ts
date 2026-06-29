import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
// import { runDeepSeekResearch } from "@/lib/deepseek-agent"; // uncomment when configured

// POST /api/agents/deepseek-research
// Scaffold for DeepSeek-based research agent. Tags all signals with agent_label='deepseek'.
// TODO: wire up lib/deepseek-agent.ts once DeepSeek API key + prompt are configured.
export async function POST(_req: NextRequest) {
  try {
    const userClient = await createClient();
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    return NextResponse.json({
      message:
        "DeepSeek research agent not yet configured — add DeepSeek prompt to lib/deepseek-agent.ts",
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
