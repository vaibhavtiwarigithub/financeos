import { NextRequest, NextResponse } from "next/server";
import { execClaude, parseClaudeOutput } from "@/lib/claude-exec";

export async function POST(req: NextRequest) {
  try {
    const { prompt, systemPrompt } = await req.json();
    if (!prompt) return NextResponse.json({ error: "No prompt" }, { status: 400 });

    const fullPrompt = systemPrompt
      ? `[System instructions: ${systemPrompt}]\n\n${prompt}`
      : prompt;

    const stdout = await execClaude(fullPrompt, 60000);
    const text = parseClaudeOutput(stdout);

    return NextResponse.json({ text, tokensUsed: 0, costUsd: 0 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "AI service error", detail: msg }, { status: 500 });
  }
}
