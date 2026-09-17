// Owner-operated OAuth recovery. No order calls; credentials never enter stdout.
// Run from the repo root: node scripts/robinhood-loopback-connect.mjs
import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';

export function validCallback(url, expectedState) {
  const states = url.searchParams.getAll('state');
  const codes = url.searchParams.getAll('code');
  if (url.pathname !== '/callback' || states.length !== 1 || codes.length !== 1 || !codes[0]) return false;
  const got = Buffer.from(states[0]);
  const expected = Buffer.from(expectedState);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

async function main() {
  process.loadEnvFile('.env.local');
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) throw new Error('Missing local Supabase configuration');
  const svc = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const host = '127.0.0.1';
  const port = 53682;
  const origin = `http://${host}:${port}`;
  const redirectUri = `${origin}/callback`;
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const resource = 'https://agent.robinhood.com/mcp/trading';
  let clientId;
  let consumed = false;
  let ready = false;
  const deadline = Date.now() + 10 * 60_000;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    if (req.method !== 'GET' || req.headers.host !== `${host}:${port}`) {
      res.writeHead(400); res.end('Invalid request'); return;
    }
    const url = new URL(req.url, origin);
    if (!ready || consumed || Date.now() > deadline || !validCallback(url, state)) {
      res.writeHead(400); res.end('Invalid or expired authorization callback.'); return;
    }
    consumed = true; // single use, including failed exchanges
    try {
      const response = await fetch('https://api.robinhood.com/oauth2/token/', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: url.searchParams.get('code'),
          redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier, resource }),
        signal: AbortSignal.timeout(20_000),
      });
      const tokens = await response.json();
      if (!response.ok || typeof tokens.access_token !== 'string' || !tokens.access_token
          || typeof tokens.refresh_token !== 'string' || !tokens.refresh_token
          || !Number.isFinite(Number(tokens.expires_in)) || Number(tokens.expires_in) <= 0) {
        throw new Error(`Token exchange failed or incomplete (HTTP ${response.status})`);
      }
      const now = new Date().toISOString();
      const values = {
        ROBINHOOD_MCP_CLIENT_ID: clientId,
        ROBINHOOD_MCP_CLIENT_REDIRECTS: JSON.stringify([redirectUri]),
        ROBINHOOD_MCP_REFRESH_TOKEN: tokens.refresh_token,
        ROBINHOOD_MCP_ACCESS_TOKEN: tokens.access_token,
        ROBINHOOD_MCP_TOKEN_EXPIRY: new Date(Date.now() + Number(tokens.expires_in) * 1000).toISOString(),
      };
      // One SQL statement: never persist a partial client/token bundle.
      const { error } = await svc.from('api_key_vault').upsert(Object.entries(values).map(([key_name, key_value]) => ({
        key_name, key_value, display_name: key_name, provider: 'robinhood_mcp', updated_at: now,
      })), { onConflict: 'key_name' });
      if (error) throw new Error('Token bundle could not be saved to the vault');
      console.log(JSON.stringify({ connected: true, callback: 'loopback', expires_at: values.ROBINHOOD_MCP_TOKEN_EXPIRY }));
      res.end('Robinhood authorization saved to Kairos. You can close this tab. No orders were submitted.');
    } catch (e) {
      // Provider bodies/codes/tokens are deliberately excluded from diagnostics.
      console.error(e instanceof Error && /^(Token exchange|Token bundle)/.test(e.message) ? e.message : 'OAuth recovery failed');
      res.writeHead(502); res.end('Authorization could not be completed. Check the local recovery terminal.');
    } finally { server.close(); clearTimeout(timer); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const timer = setTimeout(() => { console.log('Authorization window expired'); server.close(); }, 10 * 60_000);
  try {
    const response = await fetch('https://agent.robinhood.com/oauth/trading/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_name: 'Kairos FinanceOS', redirect_uris: [redirectUri],
        grant_types: ['authorization_code','refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'internal' }),
      signal: AbortSignal.timeout(15_000),
    });
    const reg = await response.json();
    if (!response.ok || !reg.client_id || !reg.redirect_uris?.includes(redirectUri)) throw new Error('Loopback registration failed');
    clientId = reg.client_id;
    ready = true;
    console.log('Authorize this URL in your browser; approve the fresh Robinhood device prompt:');
    console.log('https://robinhood.com/oauth?' + new URLSearchParams({ response_type: 'code', client_id: clientId,
      redirect_uri: redirectUri, scope: 'internal', state, code_challenge: challenge, code_challenge_method: 'S256', resource }));
  } catch { clearTimeout(timer); server.close(); throw new Error('Loopback client registration failed'); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
}
