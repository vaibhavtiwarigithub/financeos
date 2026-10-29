import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DOC_ONLY_PATHS = [
  /^WORK_LOG\.md$/i,
  /^features\/.*\.md$/i,
  /^docs\/.*\.md$/i,
  /^tests\/.+$/i,
  /^\.github\/workflows\/.+$/i,
  /^supabase\/migrations\/.+$/i,
];

export function shouldSkipDocsOnlyBuild(changedPaths) {
  return changedPaths.length === 0 || changedPaths.every((path) =>
    DOC_ONLY_PATHS.some((pattern) => pattern.test(path.replaceAll("\\", "/"))),
  );
}

export function changedPathsFromGit() {
  const result = spawnSync("git", ["diff", "--name-only", "HEAD^", "HEAD"], {
    encoding: "utf8",
    windowsHide: true,
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || "Could not compare this commit with its parent");
  }

  return result.stdout.split(/\r?\n/).filter(Boolean);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const skipBuild = shouldSkipDocsOnlyBuild(changedPathsFromGit());
    console.log(skipBuild ? "Skipping non-runtime-only deployment." : "Application files changed; build required.");
    process.exit(skipBuild ? 0 : 1);
  } catch (error) {
    console.error("Could not classify changed files; continuing with deployment.", error);
    process.exit(1);
  }
}
