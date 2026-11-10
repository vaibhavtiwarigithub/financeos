import test from "node:test";
import assert from "node:assert/strict";
import { PROJECT } from "./provider-cache-archive.mjs";
import { objectPrefix, assertRestoreReceipt, assertArchivePath, assertNoSpendBudget } from "./r2-cache-archive.mjs";

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

test("upload needs measured free-tier headroom greater than the complete archive", () => {
  assert.doesNotThrow(() => assertNoSpendBudget(100, 200));
  for (const headroom of [undefined, NaN, 0, 99, 10 * 1024 ** 3 + 1]) {
    assert.throws(() => assertNoSpendBudget(100, headroom));
  }
  assert.throws(() => assertNoSpendBudget(9 * 1024 ** 3 + 1, 10 * 1024 ** 3));
});
