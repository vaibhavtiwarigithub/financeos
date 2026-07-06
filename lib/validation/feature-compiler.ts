// Phase 3 learning-core: governed feature compiler. LLM-authored feature specs
// are NEVER executed as code — only this whitelisted expression grammar is
// interpreted: + - * / (binary), unary -, and the functions log/abs/min/max/lag.
// Identifiers may reference any key already present in a decision_observations
// row's flattened context (dimension scores + evidence.<dim>.<field>).
//
// This is a tokenizer + recursive-descent parser + evaluator, restricted by
// construction — there is no eval(), no Function(), no dynamic code path.

type Token = { type: "num" | "ident" | "op" | "lparen" | "rparen" | "comma"; value: string };

const ALLOWED_FUNCS = new Set(["log", "abs", "min", "max", "lag"]);

export class FeatureCompileError extends Error {}

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i; while (j < expr.length && /[0-9.]/.test(expr[j])) j++;
      tokens.push({ type: "num", value: expr.slice(i, j) }); i = j; continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i; while (j < expr.length && /[a-zA-Z0-9_.]/.test(expr[j])) j++;
      tokens.push({ type: "ident", value: expr.slice(i, j) }); i = j; continue;
    }
    if ("+-*/".includes(c)) { tokens.push({ type: "op", value: c }); i++; continue; }
    if (c === "(") { tokens.push({ type: "lparen", value: c }); i++; continue; }
    if (c === ")") { tokens.push({ type: "rparen", value: c }); i++; continue; }
    if (c === ",") { tokens.push({ type: "comma", value: c }); i++; continue; }
    throw new FeatureCompileError(`Disallowed character '${c}' in feature expression`);
  }
  return tokens;
}

// AST — a closed set of node types. No arbitrary code node exists.
type Node =
  | { kind: "num"; value: number }
  | { kind: "ident"; name: string }
  | { kind: "binop"; op: string; left: Node; right: Node }
  | { kind: "neg"; expr: Node }
  | { kind: "call"; fn: string; args: Node[] };

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}
  private peek(): Token | undefined { return this.tokens[this.pos]; }
  private next(): Token { const t = this.tokens[this.pos]; if (!t) throw new FeatureCompileError("Unexpected end of expression"); this.pos++; return t; }

  parse(): Node {
    const node = this.parseAdd();
    if (this.pos !== this.tokens.length) throw new FeatureCompileError(`Unexpected token at position ${this.pos}`);
    return node;
  }
  private parseAdd(): Node {
    let node = this.parseMul();
    while (this.peek()?.type === "op" && (this.peek()!.value === "+" || this.peek()!.value === "-")) {
      const op = this.next().value;
      node = { kind: "binop", op, left: node, right: this.parseMul() };
    }
    return node;
  }
  private parseMul(): Node {
    let node = this.parseUnary();
    while (this.peek()?.type === "op" && (this.peek()!.value === "*" || this.peek()!.value === "/")) {
      const op = this.next().value;
      node = { kind: "binop", op, left: node, right: this.parseUnary() };
    }
    return node;
  }
  private parseUnary(): Node {
    if (this.peek()?.type === "op" && this.peek()!.value === "-") { this.next(); return { kind: "neg", expr: this.parseUnary() }; }
    return this.parsePrimary();
  }
  private parsePrimary(): Node {
    const t = this.next();
    if (t.type === "num") return { kind: "num", value: parseFloat(t.value) };
    if (t.type === "lparen") { const inner = this.parseAdd(); if (this.next().type !== "rparen") throw new FeatureCompileError("Missing closing paren"); return inner; }
    if (t.type === "ident") {
      if (this.peek()?.type === "lparen") {
        if (!ALLOWED_FUNCS.has(t.value)) throw new FeatureCompileError(`Function '${t.value}' is not in the whitelist`);
        this.next(); // consume (
        const args: Node[] = [];
        if (this.peek()?.type !== "rparen") {
          args.push(this.parseAdd());
          while (this.peek()?.type === "comma") { this.next(); args.push(this.parseAdd()); }
        }
        if (this.next().type !== "rparen") throw new FeatureCompileError("Missing closing paren in function call");
        return { kind: "call", fn: t.value, args };
      }
      return { kind: "ident", name: t.value };
    }
    throw new FeatureCompileError(`Unexpected token '${t.value}'`);
  }
}

export interface FeatureContext {
  values: Record<string, number | null | undefined>;
  // Optional recent history for lag(field, n) — series[field][0] = most recent.
  series?: Record<string, (number | null)[]>;
}

function evalNode(node: Node, ctx: FeatureContext): number | null {
  switch (node.kind) {
    case "num": return node.value;
    case "ident": {
      const v = ctx.values[node.name];
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    }
    case "neg": { const v = evalNode(node.expr, ctx); return v == null ? null : -v; }
    case "binop": {
      const l = evalNode(node.left, ctx), r = evalNode(node.right, ctx);
      if (l == null || r == null) return null;
      switch (node.op) {
        case "+": return l + r;
        case "-": return l - r;
        case "*": return l * r;
        case "/": return r === 0 ? null : l / r;
      }
      return null;
    }
    case "call": {
      const args = node.args.map(a => evalNode(a, ctx));
      switch (node.fn) {
        case "log": return args[0] != null && args[0]! > 0 ? Math.log(args[0]!) : null;
        case "abs": return args[0] == null ? null : Math.abs(args[0]!);
        case "min": return args.some(a => a == null) ? null : Math.min(...(args as number[]));
        case "max": return args.some(a => a == null) ? null : Math.max(...(args as number[]));
        case "lag": {
          // lag(fieldName, n) — fieldName must be a bare identifier, n a literal.
          const fieldNode = node.args[0];
          const nNode = node.args[1];
          if (fieldNode?.kind !== "ident" || nNode?.kind !== "num") return null;
          const series = ctx.series?.[fieldNode.name];
          const n = Math.round(nNode.value);
          if (!series || n < 0 || n >= series.length) return null;
          const v = series[n];
          return typeof v === "number" ? v : null;
        }
      }
      return null;
    }
  }
}

// Compile + evaluate a whitelisted feature formula in one call. Throws
// FeatureCompileError on any disallowed syntax; returns null (not an error)
// when inputs are missing at evaluation time — a missing input abstains,
// it doesn't crash the caller.
export function evaluateFeature(formula: string, ctx: FeatureContext): number | null {
  const ast = new Parser(tokenize(formula)).parse();
  return evalNode(ast, ctx);
}

// Validates that a formula only references identifiers in the allowed set
// (the feature spec's declared `inputs`) — called before a feature is ever
// stored, so a proposal can't silently read fields outside what it declared.
export function validateFeatureInputs(formula: string, allowedInputs: string[]): GenomeLikeValidation {
  const allowed = new Set(allowedInputs);
  function walk(node: Node): string | null {
    if (node.kind === "ident" && !allowed.has(node.name)) return node.name;
    if (node.kind === "neg") return walk(node.expr);
    if (node.kind === "binop") return walk(node.left) ?? walk(node.right);
    if (node.kind === "call") {
      for (let i = 0; i < node.args.length; i++) {
        // lag's first arg is a bare field reference by convention, still must be declared.
        const r = walk(node.args[i]);
        if (r) return r;
      }
    }
    return null;
  }
  let ast: Node;
  try { ast = new Parser(tokenize(formula)).parse(); }
  catch (e) { return { ok: false, reason: e instanceof Error ? e.message : String(e) }; }
  const undeclared = walk(ast);
  if (undeclared) return { ok: false, reason: `Formula references undeclared input '${undeclared}'` };
  return { ok: true };
}

interface GenomeLikeValidation { ok: boolean; reason?: string }
