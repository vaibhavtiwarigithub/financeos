const WATCHLIST_PATH = "/v1/user-watchlist";
const MAX_WATCHLIST_ROWS = 1_000;
const MAX_BODY_BYTES = 4_096;

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function secureEqual(expected, actual) {
  if (typeof expected !== "string" || expected.length < 32 || typeof actual !== "string") return false;
  const encoder = new TextEncoder();
  const left = encoder.encode(expected);
  const right = encoder.encode(actual);
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

function validUserId(value) {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validSymbol(value) {
  return typeof value === "string" && /^[A-Z0-9.^_=-]{1,32}$/.test(value);
}

async function readWatchlist(request, env) {
  const userId = new URL(request.url).searchParams.get("user_id");
  if (!validUserId(userId)) return json({ error: "invalid_user_id" }, 400);
  const result = await env.DB.prepare(
    "SELECT id, symbol, market, added_at FROM user_watchlist WHERE user_id = ? ORDER BY added_at DESC LIMIT ?",
  ).bind(userId, MAX_WATCHLIST_ROWS).all();
  return json({ items: result.results ?? [] });
}

async function addWatchlistItem(request, env) {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) return json({ error: "body_too_large" }, 413);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (JSON.stringify(body).length > MAX_BODY_BYTES) return json({ error: "body_too_large" }, 413);
  const userId = body?.user_id;
  const symbol = typeof body?.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  const market = typeof body?.market === "string" ? body.market.toLowerCase() : "";
  if (!validUserId(userId)) return json({ error: "invalid_user_id" }, 400);
  if (!validSymbol(symbol)) return json({ error: "invalid_symbol" }, 400);
  if (market !== "us" && market !== "india") return json({ error: "invalid_market" }, 400);

  await env.DB.prepare(
    "INSERT INTO user_watchlist (id, user_id, symbol, market, added_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, symbol, market) DO NOTHING",
  ).bind(crypto.randomUUID(), userId, symbol, market, new Date().toISOString()).run();
  return json({ ok: true, symbol, market });
}

async function deleteWatchlistItem(request, env) {
  const params = new URL(request.url).searchParams;
  const userId = params.get("user_id");
  const symbol = params.get("symbol")?.trim().toUpperCase() ?? "";
  const market = params.get("market")?.toLowerCase() ?? "us";
  if (!validUserId(userId)) return json({ error: "invalid_user_id" }, 400);
  if (!validSymbol(symbol)) return json({ error: "invalid_symbol" }, 400);
  if (market !== "us" && market !== "india") return json({ error: "invalid_market" }, 400);

  await env.DB.prepare(
    "DELETE FROM user_watchlist WHERE user_id = ? AND symbol = ? AND market = ?",
  ).bind(userId, symbol, market).run();
  return json({ ok: true });
}

export async function handleRequest(request, env) {
  if (!env.KAIROS_GATEWAY_TOKEN || !env.DB) return json({ error: "gateway_not_configured" }, 503);
  const authorization = request.headers.get("authorization") ?? "";
  const [scheme, token, extra] = authorization.split(" ");
  if (scheme !== "Bearer" || extra || !secureEqual(env.KAIROS_GATEWAY_TOKEN, token ?? "")) {
    return json({ error: "unauthorized" }, 401);
  }

  const url = new URL(request.url);
  if (url.pathname !== WATCHLIST_PATH) return json({ error: "not_found" }, 404);
  try {
    if (request.method === "GET") return await readWatchlist(request, env);
    if (request.method === "POST") return await addWatchlistItem(request, env);
    if (request.method === "DELETE") return await deleteWatchlistItem(request, env);
    return json({ error: "method_not_allowed" }, 405);
  } catch {
    return json({ error: "database_unavailable" }, 503);
  }
}

export default { fetch: handleRequest };
