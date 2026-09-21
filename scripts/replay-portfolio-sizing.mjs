// Read-only CLI: node scripts/replay-portfolio-sizing.mjs reviewed-input.json
// Node 24's built-in TS stripping; no credentials, database calls or writes.
import fs from "node:fs";
import crypto from "node:crypto";
import { replayPortfolioSizing } from "../lib/replay/portfolio-sizing.ts";

const inputPath = process.argv[2];
if (!inputPath) throw new Error("Provide a reviewed JSON file containing {plan,tape}");
const raw = fs.readFileSync(inputPath);
const input = JSON.parse(raw.toString("utf8"));
const result = replayPortfolioSizing(input.plan, input.tape);
console.log(JSON.stringify({
  schemaVersion: "conditional-sizing-v1",
  evidenceClass: "diagnostic_only",
  inputSha256: crypto.createHash("sha256").update(raw).digest("hex"),
  engineSha256: crypto.createHash("sha256").update(fs.readFileSync(new URL("../lib/replay/portfolio-sizing.ts", import.meta.url))).digest("hex"),
  plan: input.plan,
  ...result,
  limitations: [
    "Conditions on historical purchases; not a replay of the full candidate universe.",
    "Frozen execution prices/exit proportions do not model size-dependent market impact.",
    "Drawdown is sampled at supplied events; incomplete sampling can miss intraday losses.",
    "No deposits, dividends, tax, top-ups, benchmark comparison or statistical significance modeled.",
    "This output cannot establish maximum achievable return or authorize promotion/trading.",
  ],
}, null, 2));
if (result.status === "invalid") process.exitCode = 2;
