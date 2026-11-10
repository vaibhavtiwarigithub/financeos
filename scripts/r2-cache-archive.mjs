// Copies an already verified provider-cache archive to a private Cloudflare R2
// bucket, then downloads and verifies every object. Never deletes source rows.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { PROJECT, assertPrivateDirectory, verify } from "./provider-cache-archive.mjs";

const FILES = ["cache.ndjson.gz", "manifest.json", "restore-verification.json"];
const MAX_ARCHIVE_BYTES = 9 * 1024 ** 3; // Stay below R2 Standard's 10 GB-month free allowance.

export function assertNoSpendBudget(bytes, confirmedFreeHeadroom) {
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_ARCHIVE_BYTES
    || !Number.isSafeInteger(confirmedFreeHeadroom) || confirmedFreeHeadroom < bytes
    || confirmedFreeHeadroom > 10 * 1024 ** 3) {
    throw new Error("Verified R2 free-tier headroom is required before upload");
  }
}

function sha256(file) {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const chunk = Buffer.alloc(1024 * 1024);
    for (let n; (n = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0;) hash.update(chunk.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return hash.digest("hex");
}

export function assertArchivePath(dir) {
  const root = path.resolve(process.env.LOCALAPPDATA ?? "", "Kairos/backups/provider-cache");
  const target = path.resolve(dir);
  if (process.platform !== "win32" || !fs.existsSync(target)
    || !target.startsWith(root + path.sep)
    || !fs.realpathSync(target).startsWith(fs.realpathSync(root) + path.sep)) {
    throw new Error("Use an existing owner-protected provider-cache archive outside the repository");
  }
  return target;
}

export function objectPrefix(bucket, manifest) {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error("Invalid R2 bucket name");
  if (manifest.project !== PROJECT || manifest.table !== "public.av_cache"
    || !/^[a-f0-9]{64}$/.test(manifest.datasetSha256)) throw new Error("Invalid archive manifest");
  return `${bucket}/kairos/${PROJECT}/av-cache/${manifest.datasetSha256}`;
}

export function assertRestoreReceipt(manifest, receipt) {
  if (manifest.syntheticOnly || receipt.postgresMajor !== 17
    || receipt.rowCount !== manifest.rowCount || receipt.datasetSha256 !== manifest.datasetSha256) {
    throw new Error("Matching real PostgreSQL restore receipt required before remote backup");
  }
}

function wrangler(args) {
  return new Promise((resolve, reject) => {
    // Wrangler is an ephemeral CLI dependency; no API key enters argv or logs.
    const child = spawn("npx.cmd", ["--yes", "wrangler@4.160.0", ...args],
      { shell: true, windowsHide: true, stdio: "ignore" });
    child.once("error", () => reject(new Error("Wrangler could not start")));
    child.once("close", code => code === 0 ? resolve() : reject(new Error(
      `Cloudflare operation failed (exit ${code}); source archive and production rows preserved. Check Wrangler login, bucket access, and free-tier status.`)));
  });
}

export async function syncArchive(dir, bucket, run = wrangler) {
  const source = assertArchivePath(dir);
  assertPrivateDirectory(source);
  const manifest = await verify(source);
  const receipt = JSON.parse(fs.readFileSync(path.join(source, "restore-verification.json"), "utf8"));
  assertRestoreReceipt(manifest, receipt);
  const prefix = objectPrefix(bucket, manifest);
  const bytes = FILES.reduce((sum, name) => sum + fs.statSync(path.join(source, name)).size, 0);
  assertNoSpendBudget(bytes, Number(process.env.KAIROS_R2_VERIFIED_FREE_HEADROOM_BYTES));
  const expected = Object.fromEntries(FILES.map(name => [name, sha256(path.join(source, name))]));
  const retrieved = fs.mkdtempSync(path.join(source, "r2-download-"));
  try {
    // Explicit --remote is required: Wrangler otherwise defaults to local storage
    // for some R2 commands. Keep objects private; never enable an r2.dev URL.
    await run(["r2", "bucket", "info", bucket]);
    for (const name of FILES) await run(["r2", "object", "put", `${prefix}/${name}`,
      "--remote", "--file", path.join(source, name), "--storage-class", "Standard"]);
    for (const name of FILES) {
      const output = path.join(retrieved, name);
      await run(["r2", "object", "get", `${prefix}/${name}`, "--remote", "--file", output]);
      if (!fs.existsSync(output) || sha256(output) !== expected[name]) {
        throw new Error(`R2 round-trip checksum mismatch for ${name}; source archive preserved`);
      }
    }
    const remoteManifest = await verify(retrieved);
    const remoteReceipt = JSON.parse(fs.readFileSync(path.join(retrieved, "restore-verification.json"), "utf8"));
    assertRestoreReceipt(remoteManifest, remoteReceipt);
    const result = { verifiedAt: new Date().toISOString(), bucket, objectPrefix: prefix.slice(bucket.length + 1),
      project: PROJECT, rows: manifest.rowCount, compressedBytes: manifest.compressedBytes,
      datasetSha256: manifest.datasetSha256, objectsSha256: expected, productionRowsDeleted: 0 };
    const receiptFile = path.join(source, "r2-verification.json");
    fs.writeFileSync(receiptFile, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
    return result;
  } finally {
    // Download copies are reproducible; only the checked local source remains.
    if (!fs.realpathSync(retrieved).startsWith(fs.realpathSync(source) + path.sep)) {
      throw new Error("Unexpected R2 download directory; manual inspection required");
    }
    fs.rmSync(retrieved, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [dir, bucket] = process.argv.slice(2);
  if (!dir || !bucket) {
    console.error("Usage: node scripts/r2-cache-archive.mjs <verified-archive-directory> <private-r2-bucket>");
    process.exitCode = 1;
  } else {
    try {
      const result = await syncArchive(dir, bucket);
      console.log(JSON.stringify({ remoteBackupVerified: true, rows: result.rows, compressedBytes: result.compressedBytes }));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
