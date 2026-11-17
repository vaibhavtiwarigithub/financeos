import test from "node:test";
import assert from "node:assert/strict";
import { PROJECT } from "./provider-cache-archive.mjs";
import { objectPrefix, assertRestoreReceipt, assertArchivePath } from "./r2-cache-archive.mjs";
import { assertUploadWithinBudget, checkR2Capacity, R2_MAX_OBJECT_METADATA_BYTES,
  R2_UPLOAD_CEILING_BYTES } from "./r2-capacity-guard.mjs";

const manifest = { project: PROJECT, table: "public.av_cache", datasetSha256: "a".repeat(64),
  rowCount: 28082, compressedBytes: 64500000 };
const receipt = { postgresMajor: 17, rowCount: 28082, datasetSha256: "a".repeat(64) };

test("R2 object keys are private, project scoped and content addressed", () => {
  assert.equal(objectPrefix("kairos-private-archive", manifest),
    `kairos-private-archive/kairos/${PROJECT}/av-cache/${"a".repeat(64)}`);
  for (const bucket of ["x", "../other", "UPPERCASE", "name/other", "name space"]) {
    assert.throws(() => objectPrefix(bucket, manifest));
  }
  assert.throws(() => objectPrefix("kairos-private-archive", { ...manifest, project: "other" }));
  assert.throws(() => objectPrefix("kairos-private-archive", { ...manifest, table: "public.trade_log" }));
  assert.throws(() => objectPrefix("kairos-private-archive", { ...manifest, datasetSha256: "bad" }));
});

test("remote backup refuses synthetic or nonmatching local restore evidence", () => {
  assert.doesNotThrow(() => assertRestoreReceipt(manifest, receipt));
  assert.throws(() => assertRestoreReceipt({ ...manifest, syntheticOnly: true }, receipt));
  assert.throws(() => assertRestoreReceipt(manifest, { ...receipt, rowCount: 1 }));
  assert.throws(() => assertRestoreReceipt(manifest, { ...receipt, datasetSha256: "b".repeat(64) }));
  assert.throws(() => assertRestoreReceipt(manifest, { ...receipt, postgresMajor: 16 }));
});

test("archive path stays under the protected local backup root", () => {
  assert.throws(() => assertArchivePath(process.cwd()));
  assert.throws(() => assertArchivePath("../other"));
});

test("upload capacity counts payload plus maximum R2 metadata and stops at the 7.5 GB ceiling", () => {
  const exact = R2_UPLOAD_CEILING_BYTES - R2_MAX_OBJECT_METADATA_BYTES;
  assert.equal(assertUploadWithinBudget([], [{ bucket: "kairos-private-archive", key: "a", size: exact }]).projectedBytes,
    R2_UPLOAD_CEILING_BYTES);
  assert.throws(() => assertUploadWithinBudget([], [{ bucket: "kairos-private-archive", key: "a", size: exact + 1 }]), /upload refused/);
  assert.throws(() => assertUploadWithinBudget([], []), /empty/);
  assert.throws(() => assertUploadWithinBudget([], [
    { bucket: "b", key: "same", size: 1 }, { bucket: "b", key: "same", size: 1 },
  ]), /Duplicate/);
});

test("capacity preflight accounts for existing bucket objects and replacements", () => {
  const inventory = [{ bucket: "other", key: "keep", size: 1_000 },
    { bucket: "kairos-private-archive", key: "archive/data", size: 5_000 }];
  const result = assertUploadWithinBudget(inventory, [
    { bucket: "kairos-private-archive", key: "archive/data", size: 2_000 },
  ]);
  assert.equal(result.currentBytes, 1_000 + 5_000 + 2 * R2_MAX_OBJECT_METADATA_BYTES);
  assert.equal(result.projectedBytes, 1_000 + 2_000 + 2 * R2_MAX_OBJECT_METADATA_BYTES);
});

test("capacity inventory paginates every bucket and fails closed on errors", async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(String(url));
    if (String(url).includes("/r2/buckets?")) return new Response(JSON.stringify({
      success: true, errors: [], result: { buckets: [{ name: "one" }] }, result_info: { total_count: 1 },
    }));
    const cursor = new URL(url).searchParams.get("cursor");
    return new Response(JSON.stringify(cursor ? {
      success: true, errors: [], result: [{ key: "b", size: 2 }], result_info: { is_truncated: false },
    } : {
      success: true, errors: [], result: [{ key: "a", size: 1 }], result_info: { is_truncated: true, cursor: "next" },
    }));
  };
  const result = await checkR2Capacity({ accountId: "a".repeat(32), token: "t".repeat(32), fetchImpl,
    incomingObjects: [{ bucket: "one", key: "new", size: 10 }] });
  assert.equal(result.currentBytes, 1 + 2 + 2 * R2_MAX_OBJECT_METADATA_BYTES);
  assert.equal(calls.length, 3);
  await assert.rejects(checkR2Capacity({ accountId: "a".repeat(32), token: "t".repeat(32),
    fetchImpl: async () => new Response("{}", { status: 403 }),
    incomingObjects: [{ bucket: "one", key: "new", size: 10 }] }), /inventory failed/);
});
