// Opt-in, synthetic-only integration test using already-installed PostgreSQL 17.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { PROJECT, rowDigest, datasetDigest } from './provider-cache-archive.mjs';

test('isolated PostgreSQL restores synthetic JSON numbers, Unicode and microseconds', {
  skip: process.platform !== 'win32' || process.env.KAIROS_LOCAL_POSTGRES_DRILL !== '1',
  timeout: 120000,
}, () => {
  const root = path.join(process.env.LOCALAPPDATA, 'Kairos/backups/provider-cache');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'synthetic-'));
  const identity = execFileSync('whoami.exe', { encoding: 'utf8', windowsHide: true }).trim();
  execFileSync('icacls.exe', [dir, '/inheritance:r', '/grant:r', `${identity}:(OI)(CI)F`], { windowsHide: true, stdio: 'ignore' });
  const rows = [
    { cache_key: 'TEST-NO-REAL-ASSET:"a",\nline', cache_date: '2026-01-01', payload_text: '{"n": 9007199254740993, "name": "₹ — café"}', fetched_at: '2026-01-01T01:02:03.123456+00:00' },
    { cache_key: 'TEST-NO-REAL-ASSET-b', cache_date: '2026-01-02', payload_text: '{"test": true}', fetched_at: '2026-01-02T00:00:00Z' },
  ];
  const compressed = gzipSync(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'cache.ndjson.gz'), compressed);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ version: 1, project: PROJECT, table: 'public.av_cache',
    syntheticOnly: true, cutoff: '2026-01-03', rowCount: rows.length,
    compressedSha256: createHash('sha256').update(compressed).digest('hex'), datasetSha256: datasetDigest(rows.map(rowDigest)) }));
  execFileSync(process.execPath, ['scripts/provider-cache-archive.mjs', 'drill', dir], { windowsHide: true, timeout: 110000, stdio: 'pipe' });
  const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'restore-verification.json'), 'utf8'));
  assert.equal(receipt.rowCount, 2);
  assert.equal(receipt.productionRowsDeleted, 0);
  assert.equal(fs.existsSync(path.join(dir, 'drill-password.tmp')), false);
  assert.equal(fs.existsSync(path.join(dir, 'restore-drill/postmaster.pid')), false);
  console.log(JSON.stringify({ syntheticRestoreVerified: true, directory: dir }));
});
