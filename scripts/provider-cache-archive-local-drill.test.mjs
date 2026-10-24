// Opt-in, synthetic-only integration test using already-installed PostgreSQL 17.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { PROJECT, drill, pruneSql, rowDigest, datasetDigest } from './provider-cache-archive.mjs';

test('isolated PostgreSQL restores exact data and prunes only unchanged superseded rows', {
  skip: process.platform !== 'win32' || process.env.KAIROS_LOCAL_POSTGRES_DRILL !== '1',
  timeout: 120000,
}, async () => {
  const root = path.join(process.env.LOCALAPPDATA, 'Kairos/backups/provider-cache');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'synthetic-'));
  const identity = execFileSync('whoami.exe', { encoding: 'utf8', windowsHide: true }).trim();
  execFileSync('icacls.exe', [dir, '/inheritance:r', '/grant:r', `${identity}:(OI)(CI)F`], { windowsHide: true, stdio: 'ignore' });
  const rows = [
    { cache_key: 'TEST-NO-REAL-ASSET:"a",\nline\'; DROP TABLE av_cache; --', cache_date: '2026-01-01', payload_text: '{"n": 9007199254740993, "name": "₹ — café"}', fetched_at: '2026-01-01T01:02:03.123456+00:00' },
    { cache_key: 'TEST-NO-REAL-ASSET-b', cache_date: '2026-01-02', payload_text: '{"test": true}', fetched_at: '2026-01-02T00:00:00Z' },
  ];
  const compressed = gzipSync(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'cache.ndjson.gz'), compressed);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ version: 1, project: PROJECT, table: 'public.av_cache',
    syntheticOnly: true, cutoff: '2026-01-03', rowCount: rows.length,
    compressedSha256: createHash('sha256').update(compressed).digest('hex'), datasetSha256: datasetDigest(rows.map(rowDigest)) }));
  await drill(dir, async sql => {
    await sql(`INSERT INTO av_cache SELECT cache_key, DATE '2026-10-24', payload, fetched_at FROM av_cache;
      UPDATE av_cache SET payload='{"test": false}'::jsonb WHERE cache_key='TEST-NO-REAL-ASSET-b' AND cache_date='2026-01-02';
      INSERT INTO av_cache VALUES ('only-latest-old','2026-01-02','{"test": true}','2026-01-02T00:00:00Z'),
      ('changed-time','2026-01-02','{"test": true}','2026-01-02T00:00:00.000001Z'),
      ('changed-time','2026-10-24','{"test": true}','2026-01-02T00:00:00Z');`);
    const candidates = [...rows, { ...rows[1], cache_key: 'only-latest-old' }, { ...rows[1], cache_key: 'changed-time' }, { ...rows[1], cache_key: 'already-missing' }];
    const planned = JSON.parse((await sql(pruneSql(candidates, '2026-09-09'))).trim());
    assert.equal(planned.matched, 1);
    const applied = JSON.parse((await sql(pruneSql(candidates, '2026-09-09', true))).trim());
    assert.equal(applied.matched, 1);
    const repeated = JSON.parse((await sql(pruneSql(candidates, '2026-09-09', true))).trim());
    assert.equal(repeated.matched, 0);
    const remaining = JSON.parse((await sql(`SELECT json_build_object('total',count(*),'newest',count(*) FILTER(WHERE cache_date='2026-10-24'),
      'solo',count(*) FILTER(WHERE cache_key='only-latest-old')) FROM av_cache;`)).trim());
    assert.deepEqual(remaining, { total: 6, newest: 3, solo: 1 });
  });
  const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'restore-verification.json'), 'utf8'));
  assert.equal(receipt.rowCount, 2);
  assert.equal(receipt.productionRowsDeleted, 0);
  assert.equal(fs.existsSync(path.join(dir, 'drill-password.tmp')), false);
  assert.equal(fs.existsSync(path.join(dir, 'restore-drill/postmaster.pid')), false);
  console.log(JSON.stringify({ syntheticRestoreVerified: true, directory: dir }));
});
