import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@/lib/supabase/server";
import { TIER_LIMITS } from "@/types";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // Get profile + tier
    const { data: profile } = await supabase
      .from("profiles")
      .select("subscription_tier, analysis_count, xp")
      .eq("id", user.id)
      .single();

    const tier = profile?.subscription_tier ?? "free";
    const limit = TIER_LIMITS[tier as keyof typeof TIER_LIMITS].aiQueriesPerDay;

    // Check daily usage
    const { data: usageCount } = await supabase
      .rpc("get_daily_ai_count", { p_user_id: user.id });

    if (limit !== Infinity && (usageCount ?? 0) >= limit) {
      return NextResponse.json({
        error: `Daily limit reached. ${tier === "free" ? "Upgrade to Pro for 50 queries/day." : "Upgrade to Elite for unlimited."}`,
        limitReached: true,
        tier,
      }, { status: 429 });
    }

    const { prompt, systemPrompt, model = "claude-sonnet-4-20250514" } = await req.json();
    if (!prompt) return NextResponse.json({ error: "No prompt" }, { status: 400 });

    const response = await anthropic.messages.create({
      model,
      max_tokens: 1500,
      system: systemPrompt || "You are a world-class financial analyst. Be concise, specific, and data-driven.",
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content.map(c => c.type === "text" ? c.text : "").join("");
    const tokensUsed = response.usage.input_tokens + response.usage.output_tokens;
    const costUsd = tokensUsed * 0.000003;

    // Log usage
    await supabase.from("usage_logs").insert({
      user_id: user.id,
      action: "ai_query",
      tokens_used: tokensUsed,
      cost_usd: costUsd,
    });

    // Update profile stats
    await supabase.from("profiles").update({
      analysis_count: (profile?.analysis_count ?? 0) + 1,
      xp: (profile?.xp ?? 0) + 10,
    }).eq("id", user.id);

    return NextResponse.json({ text, tokensUsed, costUsd });
  } catch (err: unknown) {
    console.error("AI API error:", err);
    return NextResponse.json({ error: "AI service error" }, { status: 500 });
  }
}
