import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { providerForModel, LLM_PROVIDERS } from "@/lib/llm-keys";

// Source scans must ignore COMMENTS: every fix below explains itself in prose that
// names the very string being removed. Scanning raw source would match the
// explanation and fail — a trap an agent hit for real earlier in this batch.
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 "); // line comments (not `://` in a URL)
}

describe("deep-dive keys the provider it is CONFIGURED for", () => {
  // The route used to demand DEEPSEEK_API_KEY before resolving the model, so any
  // non-DeepSeek pick in Settings -> Agents -> LLM Config returned 503
  // "DEEPSEEK_API_KEY not set" — a per-flow model picker that accepted one provider.
  it("resolves each configured model to its own provider", () => {
    expect(providerForModel("deepseek-reasoner")).toBe("deepseek");
    expect(providerForModel("llama-3.3-70b-versatile")).toBe("groq"); // theme-scout's real prod model
    expect(providerForModel("gemini-2.5-flash")).toBe("gemini");
    expect(providerForModel("not-a-real-model")).toBeNull();
  });

  it("names the right env var per provider, so the 503 tells you what to set", () => {
    expect(LLM_PROVIDERS[providerForModel("llama-3.3-70b-versatile")!].envVar).toBe("GROQ_API_KEY");
    expect(LLM_PROVIDERS[providerForModel("deepseek-reasoner")!].envVar).toBe("DEEPSEEK_API_KEY");
  });

  it("does not hardcode a deepseek key check ahead of model resolution", () => {
    const src = code("app/api/agents/deep-dive/route.ts");
    expect(src).not.toMatch(/getProviderKey\(\s*["']deepseek["']/);
    expect(src).toMatch(/providerForModel\(/);
  });

  it("owner-gates service-role reads and accepts the canonical India symbol grammar", () => {
    const src = code("app/api/agents/deep-dive/route.ts");
    expect(src).toMatch(/requireOwner\(\)/);
    expect(src).toMatch(/isPlausibleWatchlistSymbol\(symbol\)/);
    expect(src).toMatch(/fetchIndiaQuote\(symbol\)/);
    expect(src).toMatch(/fetchIndiaOverview\(symbol\)/);
  });
});

describe("learner routes only models this app can serve", () => {
  it("has no Anthropic fallback — execClaude is deleted, nothing can serve a claude id", () => {
    const src = code("app/api/agents/learner/route.ts");
    expect(src).not.toMatch(/claude-opus-4-8/);
  });

  it("its model fallback is routable", () => {
    const src = code("app/api/agents/learner/route.ts");
    const m = src.match(/\.model \?\? "([^"]+)"/);
    expect(m).not.toBeNull();
    expect(providerForModel(m![1]!)).not.toBeNull();
  });

  it("does not tell the LLM it uses Voyage — embeddings are Jina", () => {
    const src = code("app/api/agents/learner/route.ts");
    expect(src).not.toMatch(/Voyage/i);
  });
});

describe("theme-scout is runnable by the owner, not cron-only", () => {
  // The documented manual trigger (the run button on /dashboard/agents) posts from
  // the browser with no cron secret, so a cron-only POST gate 401'd every click.
  // GET was already owner-gated; only POST lacked the same path.
  it("POST accepts an owner session as well as the cron secret", () => {
    const src = code("app/api/agents/theme-scout/route.ts");
    const post = src.slice(src.indexOf("export async function POST"));
    const body = post.slice(0, post.indexOf("export async function GET") >>> 0 || post.length);
    expect(body).toMatch(/verifyCronSecret\(req\)/);
    expect(body).toMatch(/requireOwner\(\)/);
  });
});
