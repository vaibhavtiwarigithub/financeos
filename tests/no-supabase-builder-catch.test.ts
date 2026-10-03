import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// supabase-js query builders have `.then` but NOT `.catch`: `svc.from(x).insert(y).catch(...)` throws a TypeError
// when executed. It made every leveraged paper door crash before writing its liveness row for 11 days and was
// latent in live-order paths (after a real fill / confirmed BUY). Use bestEffort() from lib/supabase/best-effort.
const BUILDER_METHODS = new Set(["insert", "update", "upsert", "delete", "select", "eq", "neq", "gt", "gte", "lt", "lte",
  "in", "is", "not", "or", "order", "limit", "range", "single", "maybeSingle", "match", "filter", "rpc", "from"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

/** Method name of the call that ends right before index `at` (the `)` preceding `.catch(`), or null. */
function precedingCallName(text: string, at: number): string | null {
  let i = at - 1;
  while (i >= 0 && /\s/.test(text[i])) i--;
  if (text[i] !== ")") return null;
  let depth = 0;
  for (; i >= 0; i--) {
    if (text[i] === ")") depth++;
    else if (text[i] === "(") { depth--; if (depth === 0) break; }
  }
  const before = text.slice(0, i).match(/([A-Za-z_$][\w$]*)\s*$/);
  return before ? before[1] : null;
}

/** Blank out comments (keeping line breaks) so prose that quotes the broken pattern is not flagged. */
function stripComments(text: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead: string) => lead + blank(m.slice(lead.length)));
}

export function findBuilderCatches(source: string): number[] {
  const text = stripComments(source);
  const found: number[] = [];
  for (const match of text.matchAll(/\.catch\(/g)) {
    const at = match.index!;
    const name = precedingCallName(text, at);
    if (!name || !BUILDER_METHODS.has(name)) continue;
    const statementStart = Math.max(text.lastIndexOf(";", at), text.lastIndexOf("\n\n", at), 0);
    const statement = text.slice(statementStart, at);
    if (/\.(from|rpc)\(/.test(statement) && !/\.then\(/.test(statement)) found.push(text.slice(0, at).split("\n").length);
  }
  return found;
}

describe("no `.catch()` chained on a supabase query builder", () => {
  it("detector flags the broken pattern and accepts the safe ones", () => {
    expect(findBuilderCatches('await svc.from("t").insert({ a: 1 }).catch(() => {});')).toHaveLength(1);
    expect(findBuilderCatches('await svc.from("t").update({ a: 1 }).eq("id", 1).catch(() => {});')).toHaveLength(1);
    expect(findBuilderCatches('await svc.from("t").select("a").maybeSingle().then((r) => r.data).catch(() => null);')).toHaveLength(0);
    expect(findBuilderCatches("await reportIssue({ a: 1 }).catch(() => {});")).toHaveLength(0);
    expect(findBuilderCatches('await bestEffort(svc.from("t").insert({ a: 1 }), "t");')).toHaveLength(0);
  });
  it("no source file under app/ or lib/ contains one", () => {
    const offenders: string[] = [];
    for (const file of [...walk("app"), ...walk("lib")]) {
      for (const line of findBuilderCatches(readFileSync(file, "utf8"))) offenders.push(`${file}:${line}`);
    }
    expect(offenders).toEqual([]);
  });
});
