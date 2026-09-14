import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

// A Next.js `route.ts` may export ONLY HTTP method handlers and a fixed set of
// segment-config fields. Any other export fails `next build` with
// "<name> is not a valid Route export field" — but `tsc --noEmit` accepts it
// happily, so the mistake reaches CI looking locally clean. It did exactly that
// on 2026-09-14: `GUEST_VERIFIER_PREFIX` was exported from the guest Kite login
// route so the callback could import it, and only Vercel caught it. The
// constant now lives in `lib/brokers/guest-oauth.ts`; this test is the local
// detector so the next one fails here instead of in a deploy.

const ROOT = resolve(__dirname, "..");

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const CONFIG = [
  "dynamic", "revalidate", "runtime", "maxDuration",
  "fetchCache", "preferredRegion", "dynamicParams",
];
const ALLOWED = new Set([...METHODS, ...CONFIG]);

const routeFiles = execSync("find app -name route.ts", { cwd: ROOT, encoding: "utf8" })
  .split("\n").map((l) => l.trim()).filter(Boolean);

describe("route modules export only what Next.js allows", () => {
  it("finds the route files at all — an empty sweep would pass vacuously", () => {
    expect(routeFiles.length).toBeGreaterThan(20);
  });

  it("exports nothing Next.js would reject at build time", () => {
    const offenders: string[] = [];
    for (const file of routeFiles) {
      const src = readFileSync(resolve(ROOT, file), "utf8");
      for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:const|function|let|var|class)\s+(\w+)/gm)) {
        if (!ALLOWED.has(m[1])) offenders.push(`${file}: ${m[1]}`);
      }
      // A named re-export is fine as long as every name is allowed — an
      // existing route legitimately does `export { dynamic, GET } from ...`.
      // `export *` is not: its names cannot be checked here, and the build
      // would have to accept whatever the source module happens to export.
      for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
        for (const raw of m[1].split(",")) {
          const name = raw.trim().split(/\s+as\s+/).pop()?.trim();
          if (name && !ALLOWED.has(name)) offenders.push(`${file}: ${name} (re-export)`);
        }
      }
      for (const _ of src.matchAll(/^export\s*\*/gm)) {
        offenders.push(`${file}: export * (names cannot be checked)`);
      }
    }
    expect(offenders, "move these into lib/ and import them").toEqual([]);
  });
});
