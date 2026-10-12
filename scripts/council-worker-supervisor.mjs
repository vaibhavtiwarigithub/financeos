#!/usr/bin/env node
/**
 * Keeps the local council workers draining their queues. One long-lived process, no secrets of its own:
 * it only launches `council-subscription-worker.mjs <private config>` and reads that script's status lines.
 *
 * usage: node council-worker-supervisor.mjs <dir-with-council-worker-*.json> [lanes-per-worker=3] [only=<substring of config name>]
 * (the Claude CLI needs a console and the Codex shim hangs with one, so run them as two supervisors: see the setup notes in WORK_LOG)
 * - each config gets `lanes` parallel lanes (Kairos allows 3 concurrent leases per worker)
 * - a lane re-runs immediately after a job, sleeps when the queue is empty
 * - quota/auth problems pause that worker's lanes so a failing client cannot burn through the whole queue
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, renameSync, openSync, closeSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import outputClassifier from './council-worker-output.cjs';

const { classifyOutput } = outputClassifier;

const dir = resolve(process.argv[2] ?? '.');
const lanes = Math.max(1, Math.min(3, Number(process.argv[3] ?? 3)));
const only = process.argv[4] ?? '';
const worker = join(dir, 'council-subscription-worker.mjs');
const logFile = join(dir, 'worker.log');
const lockFile = join(dir, `supervisor${only ? `-${only}` : ''}.lock`);

function log(line) {
  try {
    if (existsSync(logFile) && statSync(logFile).size > 2_000_000) renameSync(logFile, `${logFile}.old`);
    appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
  } catch { /* logging must never stop the workers */ }
}

function runOnce(config) {
  return new Promise(resolveRun => {
    const child = spawn(process.execPath, [worker, config], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => child.kill(), 6 * 60_000);
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { out += c; });
    child.on('close', () => { clearTimeout(timer); resolveRun(out); });
    child.on('error', () => { clearTimeout(timer); resolveRun(''); });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function lane(name, config, state) {
  while (true) {
    if (Date.now() < state.pausedUntil) { await sleep(Math.min(60_000, state.pausedUntil - Date.now())); continue; }
    const result = classifyOutput(await runOnce(config));
    if (result.kind === 'idle') { await sleep(60_000); continue; }
    if (result.kind === 'job') {
      // A client that keeps failing (usage limit, throttling) must not burn through the whole queue: 3 in a row pauses the worker.
      state.failStreak = result.outcome === 'client_failed' ? (state.failStreak ?? 0) + 1 : 0;
      log(`${name} job ${result.outcome}`);
      if (state.failStreak >= 3) { state.failStreak = 0; state.pausedUntil = Date.now() + 10 * 60_000; log(`${name} paused 10 min: repeated client_failed`); }
      continue;
    }
    if (result.kind === 'pause') { state.pausedUntil = Date.now() + result.ms; log(`${name} paused ${Math.round(result.ms / 60000)} min: ${result.why}`); continue; }
    log(`${name} worker pass failed`);
    await sleep(30_000);
  }
}

function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { const fd = openSync(lockFile, 'wx'); writeFileSync(fd, String(process.pid)); closeSync(fd); return true; }
    catch {
      let pid = 0;
      try { pid = Number(readFileSync(lockFile, 'utf8')); } catch { /* unreadable lock: treat as stale */ }
      try { if (pid && pid !== process.pid) { process.kill(pid, 0); return false; } } catch { /* pid gone: stale */ }
      try { unlinkSync(lockFile); } catch { return false; }
    }
  }
  return false;
}

async function main() {
  if (!existsSync(worker)) { console.error('missing council-subscription-worker.mjs next to the supervisor'); process.exit(1); }
  if (!acquireLock()) { console.error('supervisor already running'); process.exit(0); }
  process.on('exit', () => { try { unlinkSync(lockFile); } catch { /* ignore */ } });
  const configs = readdirSync(dir).filter(f => /^council-worker-.+\.json$/.test(f) && (!only || f.includes(only)));
  if (!configs.length) { console.error('no council-worker-*.json found'); process.exit(1); }
  log(`supervisor start: ${configs.length} worker(s) x ${lanes} lane(s)`);
  await Promise.all(configs.flatMap(file => {
    const state = { pausedUntil: 0 };
    return Array.from({ length: lanes }, (_, i) => lane(`${file.replace(/^council-worker-|\.json$/g, '')}#${i + 1}`, join(dir, file), state));
  }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
