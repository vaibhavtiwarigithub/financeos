import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { PROJECT, verify, pruneSql, assertSourceProject, assertSettledEvents, canonicalTimestamp, rowDigest, datasetDigest, csvRow, isArchivable } from './provider-cache-archive.mjs';

const row = { cache_key: 'quote:"test",\nvalue', cache_date: '2026-01-01', payload_text: '{"n": 9007199254740993}', fetched_at: '2026-01-01T01:02:03.123456+00:00' };
test('source credential transport is restricted to the exact HTTPS project origin', () => {
  assert.equal(assertSourceProject(`https://${PROJECT}.supabase.co`), `https://${PROJECT}.supabase.co`);
  for (const url of [`http://${PROJECT}.supabase.co`, `https://user:password@${PROJECT}.supabase.co`,
    `https://${PROJECT}.supabase.co/other`, 'https://another.supabase.co']) assert.throws(() => assertSourceProject(url));
});
test('unfinished or uncertain SQL outcomes prohibit blind retry', () => {
  assertSettledEvents([]);
  assertSettledEvents([{ type: 'intent', batchHash: 'a' }, { type: 'result', batchHash: 'a' }]);
  assertSettledEvents([{ type: 'intent', batchHash: 'a' }, { type: 'rejected', batchHash: 'a' }]);
  assert.throws(() => assertSettledEvents([{ type: 'intent', batchHash: 'a' }]));
  assert.throws(() => assertSettledEvents([{ type: 'uncertain', batchHash: 'a' }]));
});
test('prune batches require exact columns, newest-row lock and strict size/cutoff limits', () => {
  const plan = pruneSql([row], '2026-01-03');
  const apply = pruneSql([row], '2026-01-03', true);
  assert.ok(!plan.includes('DELETE FROM'));
  assert.ok(apply.includes('FOR KEY SHARE'));
  for (const guard of ["encode(sha256(convert_to(c.payload::text,'UTF8')),'hex')=b.payload_sha256", 'c.fetched_at=b.fetched_at', 'c.cache_date<r.cache_date', "lock_timeout='500ms'", "statement_timeout='10s'"]) assert.ok(apply.includes(guard));
  assert.ok(!apply.includes(row.payload_text));
  assert.throws(() => pruneSql([], '2026-01-03'));
  assert.throws(() => pruneSql([row, row], '2026-01-03'));
  assert.throws(() => pruneSql([row], row.cache_date));
  assert.throws(() => pruneSql([row], "2026-01-03'; DELETE FROM x;--"));
  assert.throws(() => pruneSql([{ ...row, payload_text: 'x'.repeat(8 * 1024 * 1024) }], '2026-01-03'));
});
test('preserves microseconds and rejects non-UTC timestamp assumptions', () => {
  assert.equal(canonicalTimestamp(row.fetched_at), '2026-01-01T01:02:03.123456Z');
  assert.equal(canonicalTimestamp('2026-01-01T01:02:03Z'), '2026-01-01T01:02:03.000000Z');
  assert.throws(() => canonicalTimestamp('2026-01-01T01:02:03+05:30'));
});
test('fingerprints distinguish large JSON integers and fetched times', () => {
  assert.notEqual(rowDigest(row), rowDigest({ ...row, payload_text: '{"n": 9007199254740992}' }));
  assert.notEqual(rowDigest(row), rowDigest({ ...row, fetched_at: '2026-01-01T01:02:03.123457Z' }));
  assert.throws(() => rowDigest({ ...row, payload_text: {} }));
});
test('CSV protects quotes, commas, newlines and raw payload numbers', () => {
  const csv = csvRow(row);
  assert.ok(csv.includes('9007199254740993'));
  assert.ok(csv.includes('"quote:""test"",\nvalue"'));
});
test('only strictly older superseded rows qualify, never newest or cutoff day', () => {
  assert.equal(isArchivable(row, '2026-02-01', '2026-01-02'), true);
  assert.equal(isArchivable(row, '2026-01-01', '2026-01-02'), false);
  assert.equal(isArchivable(row, '2026-02-01', '2026-01-01'), false);
  assert.equal(isArchivable(row, undefined, '2026-01-02'), false);
});
test('dataset fingerprint ignores row order but detects missing/duplicate rows', () => {
  assert.equal(datasetDigest(['a', 'b']), datasetDigest(['b', 'a']));
  assert.notEqual(datasetDigest(['a', 'b']), datasetDigest(['a', 'b', 'b']));
});
test('archive verification rejects corruption, wrong identity and cutoff rows', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-cache-archive-test-'));
  try {
    const compressed = gzipSync(JSON.stringify(row) + '\n');
    fs.writeFileSync(path.join(dir, 'cache.ndjson.gz'), compressed);
    const manifest = { version: 1, project: PROJECT, table: 'public.av_cache', cutoff: '2026-01-02', rowCount: 1,
      datasetSha256: datasetDigest([rowDigest(row)]), compressedSha256: createHash('sha256').update(compressed).digest('hex') };
    const save = value => fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(value));
    save(manifest);
    assert.equal((await verify(dir)).rowCount, 1);
    save({ ...manifest, project: 'other-project' });
    await assert.rejects(verify(dir), /identity/);
    save({ ...manifest, cutoff: row.cache_date });
    await assert.rejects(verify(dir), /out-of-scope/);
    save({ ...manifest, datasetSha256: 'bad' });
    await assert.rejects(verify(dir), /checksum/);
    save(manifest);
    fs.appendFileSync(path.join(dir, 'cache.ndjson.gz'), 'corrupt');
    await assert.rejects(verify(dir), /checksum/);
  } finally {
    // Exact test-owned temporary directory, never a workspace or archive directory.
    fs.rmSync(dir, { recursive: true });
  }
});
