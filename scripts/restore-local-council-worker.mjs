#!/usr/bin/env node
/** Rotate one existing Kairos council worker credential without printing it.
 * Use only on the owner's signed-in workstation. No provider API key is used.
 */
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, unlinkSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const WORKERS = {
  codex: { id: '88ed93ea-3760-47b3-826f-c2996964d463', model: 'gpt-5.6-luna' },
  claude: { id: '111410d5-821f-4169-b0a4-a2b3273642a8', model: 'claude-sonnet-5-5' },
};
const PROJECT_REF = 'dionkikgdmlaotvtbnfr';
const root = join(process.env.LOCALAPPDATA ?? '', 'Kairos');
const claudeConfig = join(root, 'council-worker-claude.json');
const family = process.argv[2];
if (!Object.hasOwn(WORKERS, family)) throw new Error('Usage: node scripts/restore-local-council-worker.mjs codex|claude');
const selected = WORKERS[family];
const workerConfig = join(root, `council-worker-${family}.json`);
const stagedConfig = join(root, `.council-worker-${family}-rotating.tmp`);

function envValue(name) {
  const line = readFileSync('.env.local', 'utf8').split(/\r?\n/)
    .find(value => value.startsWith(`${name}=`));
  if (!line) throw new Error(`Missing ${name} in .env.local`);
  const value = line.slice(name.length + 1).trim();
  return value.replace(/^(["'])(.*)\1$/, '$2');
}

async function main() {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA || !existsSync(claudeConfig))
    throw new Error('Run only on the owner Windows workstation with the existing Claude worker config');
  if (existsSync(stagedConfig)) throw new Error('A prior credential rotation is unfinished');
  const claude = JSON.parse(readFileSync(claudeConfig, 'utf8'));
  const origin = new URL(claude.origin);
  if (origin.protocol !== 'https:' || origin.hostname !== 'financeos-vaibhavtiwarigithubs-projects.vercel.app')
    throw new Error('Unexpected Kairos origin');
  const apiUrl = envValue('NEXT_PUBLIC_SUPABASE_URL');
  const serviceKey = envValue('SUPABASE_SERVICE_ROLE_KEY');
  if (new URL(apiUrl).hostname !== `${PROJECT_REF}.supabase.co` || serviceKey.length < 40)
    throw new Error('Unexpected Supabase project or missing service credential');

  // Verify identity before creating a credential; never mutate a different worker.
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  const endpoint = `${apiUrl}/rest/v1/llm_council_workers?id=eq.${selected.id}&select=id,family,expected_model,revoked_at`;
  const check = await fetch(endpoint, { headers, signal: AbortSignal.timeout(10000) });
  if (!check.ok) throw new Error(`Worker lookup failed (${check.status})`);
  const rows = await check.json();
  if (rows.length !== 1 || rows[0].family !== family || rows[0].expected_model !== selected.model || rows[0].revoked_at)
    throw new Error('Selected worker identity is not active or model changed');

  const token = `kcw_${randomBytes(32).toString('hex')}`;
  writeFileSync(stagedConfig, JSON.stringify({ origin: claude.origin, token }), { flag: 'wx', mode: 0o600 });
  try {
    const account = execFileSync('whoami', { encoding: 'utf8', windowsHide: true }).trim();
    execFileSync('icacls', [stagedConfig, '/inheritance:r'], { stdio: 'ignore', windowsHide: true });
    execFileSync('icacls', [stagedConfig, '/grant:r', `${account}:F`], { stdio: 'ignore', windowsHide: true });
    const patch = await fetch(`${apiUrl}/rest/v1/llm_council_workers?id=eq.${selected.id}&family=eq.${family}&revoked_at=is.null`, {
      method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ token_sha256: createHash('sha256').update(token).digest('hex') }),
      signal: AbortSignal.timeout(10000),
    });
    if (!patch.ok || (await patch.json()).length !== 1) throw new Error(`Credential rotation failed (${patch.status})`);
    renameSync(stagedConfig, workerConfig);
  } catch (error) {
    if (existsSync(stagedConfig)) unlinkSync(stagedConfig);
    throw error;
  }
  console.log(`${family} council worker credential rotated and saved with account-only ACL; token was not printed.`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
