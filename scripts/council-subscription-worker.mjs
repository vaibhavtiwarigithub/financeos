#!/usr/bin/env node
/** Official signed-in clients only. No provider tokens/API keys accepted by this runner. */
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const forecastSchema = {
  type: 'object', additionalProperties: false,
  required: ['score', 'confidence', 'rationale', 'bull_case', 'bear_case', 'evidence_citations'],
  properties: {
    score: { type: 'number', minimum: 0, maximum: 100 }, confidence: { type: 'number', minimum: 0, maximum: 1 },
    rationale: { type: 'string' }, bull_case: { type: 'string' }, bear_case: { type: 'string' },
    evidence_citations: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', additionalProperties: false, required: ['claim', 'source', 'as_of'], properties: { claim: { type: 'string' }, source: { type: 'string' }, as_of: { type: 'string' } } } },
  },
};
export function safeClientEnv(source = process.env) {
  // Whitelist OS/session essentials. Never forward Kairos credentials, API keys,
  // provider base-URL overrides, injected OAuth tokens, or project configuration.
  const allowed = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|LANG|LC_ALL|TERM|COLORTERM|USERNAME|CODEX_HOME|CLAUDE_CONFIG_DIR)$/i;
  return Object.fromEntries(Object.entries(source).filter(([key]) => allowed.test(key)));
}
export function endpointFor(origin) {
  const u = new URL(origin);
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error('Use a plain app origin');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) throw new Error('HTTPS is required');
  return new URL('/api/agents/llm-council/worker', u).href;
}
export function clientFailureCategory(error) {
  const message = String(error?.message ?? '');
  const diagnostic = String(error?.diagnostic ?? '');
  const text = `${message}\n${diagnostic}`.toLowerCase();
  if (message === 'authentication_required' || /not logged in|authentication required|unauthorized|please run \/login|invalid api key|oauth token|token.{0,20}expired/.test(text)) return 'authentication_required';
  if (/rate.?limit|usage limit|quota exceeded|capacity limit/.test(text)) return 'subscription_quota_or_capacity';
  if (/model.{0,40}(not found|unsupported|unavailable|invalid)/.test(text)) return 'model_unavailable';
  if (/schema|structured output|json schema/.test(text)) return 'structured_output_rejected';
  if (message === 'client_output_invalid') return 'invalid_cli_output';
  if (message === 'client_timeout') return 'client_timeout';
  if (message === 'client_unavailable') return 'client_unavailable';
  if (message === 'client_output_limit') return 'client_output_limit';
  if (message === 'model_mismatch') return 'reported_model_mismatch';
  if (message === 'invalid_client') return 'invalid_client_configuration';
  return 'unclassified_cli_failure';
}
export function persistedFailureCode(category) {
  // Persist only the finite category emitted by clientFailureCategory. Raw
  // provider diagnostics stay local and are never sent to the Kairos API.
  const allowed = new Set(['authentication_required', 'subscription_quota_or_capacity', 'model_unavailable',
    'structured_output_rejected', 'invalid_cli_output', 'client_timeout', 'client_unavailable',
    'client_output_limit', 'reported_model_mismatch', 'invalid_client_configuration', 'unclassified_cli_failure']);
  return allowed.has(category) ? category : 'client_failed';
}
export function safeLocalDiagnostic(error, synthetic = false) {
  if (!synthetic) return null;
  let detail = String(error?.diagnostic ?? '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  if (!detail) return null;
  if (/FROZEN SNAPSHOT|TEST-NO-REAL-ASSET/i.test(detail)) return 'CLI diagnostic echoed synthetic prompt; content redacted';
  detail = detail.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? '';
  return detail
    .replace(/(?:sk-|kcw_|gho_)[A-Za-z0-9_.-]+/gi, '[redacted credential]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[redacted email]')
    .replace(/[A-Z]:\\[^\s]+/gi, '[redacted path]')
    .replace(/(api[_-]?key|token|authorization)(\s*[:=]\s*)\S+/gi, '$1$2[redacted]')
    .replace(/\b[A-Za-z0-9_-]{48,}\b/g, '[redacted long value]')
    .replace(/\s+/g, ' ')
    .slice(0, 240);
}
/**
 * Windows: locate a real `<command>.exe` on PATH. Spawning it directly keeps the argument array
 * intact. Windows PowerShell 5.1 silently drops empty-string arguments, which turned
 * `--tools ""` (documented "disable all tools") into a dangling `--tools`.
 */
export function resolveNativeExecutable(command, env = process.env, exists = existsSync) {
  const pathValue = env.PATH ?? env.Path ?? '';
  for (const dir of pathValue.split(';').filter(Boolean)) {
    const candidate = join(dir, `${command}.exe`);
    if (exists(candidate)) return candidate;
  }
  return null;
}
/** The Claude CLI reports run errors as a JSON envelope on STDOUT with a non-zero exit. */
export function failureFromClaudeExit(stdout, stderr) {
  try { parseClaudeResponse(stdout, ''); }
  catch (e) { if (e.message === 'client_failed' && e.diagnostic) return e; }
  const error = new Error('client_failed');
  error.diagnostic = String(stderr || stdout || '');
  return error;
}
/** Claude (without CLI schema mode) wraps JSON in one markdown fence. Strip exactly one outer fence; anything else stays invalid. */
export function stripJsonFence(text) {
  const match = /^\s*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```\s*$/i.exec(String(text ?? ''));
  return match ? match[1] : text;
}
/** Synthetic jobs only: the cited paths/dates of a rejected forecast, restricted to path-safe characters. */
export function rejectedCitationSummary(forecast) {
  const cites = Array.isArray(forecast?.evidence_citations) ? forecast.evidence_citations.slice(0, 12) : [];
  return cites.map(c => `${String(c?.source ?? '').replace(/[^A-Za-z0-9_.$\[\]\/ ,:'"-]/g, '?').slice(0, 120)} @ ${String(c?.as_of ?? '').replace(/[^A-Za-z0-9_.:+ -]/g, '?').slice(0, 40)}`);
}
/** Fixed Kairos error codes only: short, lowercase/underscore/space text. Anything else is dropped. */
export function safeServerReason(body) {
  const reason = typeof body?.error === 'string' ? body.error.trim() : '';
  return /^[A-Za-z0-9_ :,.'-]{1,160}$/.test(reason) ? reason : null;
}
export function parseClaudeResponse(raw, expectedModel) {
  const response = JSON.parse(raw);
  if (response.is_error) {
    const candidate = response.error?.message ?? response.error ?? response.result ?? response.message;
    const error = new Error('client_failed');
    if (typeof candidate === 'string') error.diagnostic = candidate;
    else if (candidate != null) error.diagnostic = JSON.stringify(candidate);
    throw error;
  }
  const reported = Object.keys(response.modelUsage ?? {});
  if (reported.length !== 1 || reported[0] !== expectedModel) throw new Error('model_mismatch');
  let forecast = response.structured_output;
  if (forecast === undefined) {
    try { forecast = JSON.parse(stripJsonFence(response.result)); }
    catch {
      const error = new Error('client_output_invalid');
      if (typeof response.result === 'string') error.diagnostic = response.result;
      throw error;
    }
  }
  return {
    forecast,
    actual_model: reported[0],
    tokens_in: response.usage?.input_tokens ?? null,
    tokens_out: response.usage?.output_tokens ?? null,
  };
}
export function client(command, args, prompt, cwd, captureAuthStatus = false) {
  return new Promise((resolveRun, reject) => {
    const env = safeClientEnv();
    const windows = process.platform === 'win32';
    let file = command; let spawnArgs = args;
    if (windows && command === 'claude') {
      // Direct spawn of the native executable. No PowerShell layer for the subscription client.
      file = resolveNativeExecutable(command, env);
      if (!file) { reject(new Error('client_unavailable')); return; }
    } else if (windows) {
      // Other clients may be .cmd shims. Prompt crosses via a UTF-8 file (PowerShell 5.1 pipes
      // ASCII and env vars are capped near 32k characters); no arguments may be empty strings.
      if (args.some(arg => arg === '')) { reject(new Error('invalid_client')); return; }
      env.KAIROS_CLIENT_NAME = command; env.KAIROS_CLIENT_ARGS = JSON.stringify(args); env.KAIROS_STDIN_FILE = join(cwd, 'kairos-stdin.txt');
      writeFileSync(env.KAIROS_STDIN_FILE, prompt ?? '', 'utf8');
      file = 'powershell.exe';
      spawnArgs = ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop"; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $OutputEncoding=[Text.UTF8Encoding]::new($false); $clientArgs = ConvertFrom-Json -InputObject $env:KAIROS_CLIENT_ARGS; $env:TERM=""; Get-Content -LiteralPath $env:KAIROS_STDIN_FILE -Raw -Encoding UTF8 | & $env:KAIROS_CLIENT_NAME @clientArgs; exit $LASTEXITCODE'];
    }
    const child = spawn(file, spawnArgs, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let size = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error('client_timeout')); }, 240_000);
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 2_000_000) { child.kill(); reject(new Error('client_output_limit')); } else stdout += chunk; });
    child.stderr.on('data', chunk => { if (stderr.length < 16_000) stderr += chunk; });
    child.on('error', () => { clearTimeout(timer); reject(new Error('client_unavailable')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) { resolveRun(captureAuthStatus ? stdout + stderr : stdout); return; }
      const redact = text => String(text).replace(/(?:sk-|kcw_|Bearer\s+)[A-Za-z0-9_.-]+/g, '[REDACTED]').slice(0, 1500);
      const e = command === 'claude' ? failureFromClaudeExit(stdout, stderr) : new Error('client_failed');
      e.diagnostic = redact(e.diagnostic ?? (captureAuthStatus ? stdout : stderr));
      reject(e);
    });
    child.stdin.on('error', () => {}); child.stdin.end(prompt ?? '');
  });
}
export async function runClient(family, model, prompt, invoke = client) {
  if (!['codex', 'claude'].includes(family) || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,119}$/.test(model)) throw new Error('invalid_client');
  const dir = await mkdtemp(join(tmpdir(), 'kairos-council-'));
  try {
    if (family === 'codex') {
      const auth = await invoke('codex', ['login', 'status'], '', dir, true);
      if (!/logged in using chatgpt/i.test(auth)) throw new Error('authentication_required');
      const schema = join(dir, 'schema.json'); const output = join(dir, 'forecast.json');
      await writeFile(schema, JSON.stringify(forecastSchema));
      const events = await invoke('codex', ['exec', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '--disable', 'shell_tool', '--disable', 'apps', '--disable', 'plugins', '--disable', 'browser_use', '--disable', 'image_generation', '-c', 'web_search="disabled"', '-c', 'model_reasoning_effort="medium"', '--model', model, '--output-schema', schema, '--output-last-message', output, '--json', '-'], prompt, dir);
      const usage = events.split('\n').flatMap(line => { try { const e = JSON.parse(line); return e.type === 'turn.completed' ? [e.usage] : []; } catch { return []; } }).at(-1);
      return { forecast: JSON.parse(await readFile(output, 'utf8')), actual_model: model, tokens_in: usage?.input_tokens ?? null, tokens_out: usage?.output_tokens ?? null };
    }
    const auth = JSON.parse(await invoke('claude', ['auth', 'status'], '', dir));
    if (!auth.loggedIn || auth.authMethod !== 'claude.ai') throw new Error('authentication_required');
    // Ask the CLI for its normal JSON envelope, then validate the forecast
    // locally and again in the Kairos worker route. Avoid CLI-side schema mode:
    // the signed-in subscription client can reject the schema before inference.
    const raw = await invoke('claude', ['--print', '--safe-mode', '--tools', '', '--no-session-persistence', '--permission-mode', 'dontAsk', '--model', model, '--output-format', 'json'], prompt, dir);
    return parseClaudeResponse(raw, model);
  } finally { await rm(dir, { recursive: true, force: true }); } // Only the exact mkdtemp-created private directory.
}
export async function main() {
  const configPath = process.argv[2];
  if (!configPath) throw new Error('Usage: node scripts/council-subscription-worker.mjs PRIVATE_CONFIG_PATH [--synthetic-only]');
  const config = JSON.parse(await readFile(resolve(configPath), 'utf8'));
  if (!/^kcw_[a-f0-9]{64}$/.test(config.token)) throw new Error('Invalid worker credential');
  const endpoint = endpointFor(config.origin);
  const post = async body => {
    const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) {
      // Kairos answers with fixed error codes (never provider output or credentials); keep them so a
      // rejected forecast says WHY instead of only a status number.
      const error = new Error(`worker_http_${response.status}`);
      error.serverReason = safeServerReason(await response.json().catch(() => null));
      throw error;
    }
    return response.json();
  };
  const { job } = await post({ action: 'claim' });
  if (!job) { console.log('No claimable job.'); return; }
  if (process.argv.includes('--synthetic-only') && !job.synthetic) throw new Error('Refusing non-synthetic job');
  let result;
  try { result = await runClient(job.family, job.expected_model, job.prompt); }
  catch (e) {
    // Keep diagnostics local and categorical. Never persist CLI stderr, prompts,
    // account identifiers, or provider-session material to Kairos.
    const category = clientFailureCategory(e);
    console.error(`[council-worker] client failure: ${category}`);
    const detail = safeLocalDiagnostic(e, Boolean(job.synthetic));
    if (detail) console.error(`[council-worker] local synthetic diagnostic: ${detail}`);
    // Persist only a finite category allowlist accepted by the worker API.
    // Raw provider diagnostics remain local and are never submitted.
    result = { actual_model: job.expected_model, failure_code: persistedFailureCode(category) };
  }
  const submission = { action: 'submit', job_id: job.job_id, lease_id: job.lease_id, input_sha256: job.input_sha256, ...result };
  // Retry the same result, never rerun inference after an ambiguous network response.
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { const accepted = await post(submission); console.log(JSON.stringify({ job: job.job_id, status: accepted.status, outcome: result.failure_code ?? 'forecast_submitted' })); return; }
    catch (e) { lastError = e; }
  }
  // Local log only (paths and dates, never claim text); lets a rejected reply be diagnosed instead of lost.
  if (lastError?.serverReason) for (const line of rejectedCitationSummary(result.forecast)) console.error(`[council-worker] rejected citation: ${line}`);
  throw lastError;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(e => { console.error(e.serverReason ? `${e.message}: ${e.serverReason}` : e.message); process.exitCode = 1; });
