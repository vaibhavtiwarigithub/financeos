/**
 * Explicit, operator-run OOS experiment executor.
 *
 * Usage:
 *   npx tsx scripts/run-oos-experiment.ts path/to/manifest.json
 *
 * The manifest must already name the current committed SHA. Registration occurs
 * before the first network call. A failed run remains an incomplete experiment;
 * it is never silently rewritten or promoted.
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { loadEnvConfig } from "@next/env";
import { EDGES } from "../lib/edges/registry";
import {
  completeOosExperiment,
  registerOosExperiment,
  runBoundOosVariant,
  validateOosManifest,
  type OosExperimentManifest,
} from "../lib/edges/oos-experiment";

function readEnvValue(name: string): string | undefined {
  const body = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "";
  return body.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]?.trim().replace(/^"|"$/g, "");
}

async function main(): Promise<void> {
  loadEnvConfig(process.cwd());
  const path = process.argv[2];
  if (!path) throw new Error("Manifest path is required.");
  const manifest = JSON.parse(fs.readFileSync(path, "utf8")) as OosExperimentManifest;
  validateOosManifest(manifest);

  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const executionPaths = [
    "lib/edges",
    "lib/data/yahoo-candles.ts",
    "scripts/run-oos-experiment.ts",
  ];
  const dirty = execFileSync(
    "git",
    ["status", "--porcelain", "--untracked-files=no", "--", ...executionPaths],
    { encoding: "utf8" },
  ).trim();
  if (head !== manifest.codeVersion) {
    throw new Error(`Manifest codeVersion ${manifest.codeVersion} does not match HEAD ${head}.`);
  }
  if (dirty) throw new Error("OOS execution code must be clean before a run.");

  const edge = EDGES.find((candidate) => candidate.id === manifest.edgeId);
  if (!edge) throw new Error(`Unknown edge ${manifest.edgeId}.`);
  const apiKey = readEnvValue("MASSIVE_API_KEY");
  const registered = await registerOosExperiment(manifest);
  process.stdout.write(`registered ${registered.id} ${registered.planFingerprint}\n`);

  const reports = [];
  for (const variant of manifest.variants) {
    process.stdout.write(`running ${variant.id}\n`);
    reports.push(await runBoundOosVariant({
      manifest,
      variantId: variant.id,
      edge,
      apiKey,
      onProgress: (message) => process.stdout.write(`[${variant.id}] ${message}\n`),
    }));
  }
  await completeOosExperiment({ experimentId: registered.id, manifest, reports });
  process.stdout.write(`completed ${registered.id}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
