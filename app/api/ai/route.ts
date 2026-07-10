import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { callLLM } from "@/lib/llm-router";

export const dynamic = "force-dynamic";

// Owner-only ad-hoc reasoning endpoint for the Intelligence page. Routes through
// the LLM router (DeepSeek by default) — it does NOT shell out to the Claude CLI.
// The previous implementation called execClaude (claude.cmd
// --dangerously-skip-permissions) with an UNAUTHENTICATED body, which on the
// local host was unauthenticated agent execution with every tool auto-approved.
// Now: gated to the owner, plain text generation, no tool access, no exec.
export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  try {
    const { prompt, systemPrompt } = await req.json();
    if (!prompt || typeof prompt !== "string") {
      return NextResponse.json({ error: "No prompt" }, { status: 400 });
    }

    const result = await callLLM({
      task: "chat",
      prompt,
      systemPrompt: typeof systemPrompt === "string" ? systemPrompt : undefined,
      agentLabel: "intelligence",
      maxTokens: 2000,
    });

    return NextResponse.json({
      text: result.text,
      tokensUsed: result.tokensIn + result.tokensOut,
      costUsd: result.costUsd,
    });
  } catch {
    // Generic message only — never leak internal error detail to the client.
    return NextResponse.json({ error: "AI service error" }, { status: 500 });
  }
}
