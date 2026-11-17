const ACCESS_ASSERTION_HEADER = "cf-access-jwt-assertion";
const OWNER_EMAIL = "vterminater@gmail.com";

function json(body, status) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
}

export function createUpstreamRequest(request, appOrigin) {
  const base = new URL(appOrigin);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new Error("APP_ORIGIN must be a plain HTTPS origin");
  }
  const incomingUrl = new URL(request.url);
  const target = new URL(`${incomingUrl.pathname}${incomingUrl.search}`, base);
  const headers = new Headers(request.headers);
  const assertion = headers.get(ACCESS_ASSERTION_HEADER);
  if (!assertion) throw new Error("Missing Cloudflare Access assertion");
  headers.set("x-forwarded-host", new URL(request.url).host);
  headers.set("x-forwarded-proto", "https");
  return new Request(new Request(target, request), { headers, redirect: "manual" });
}

export async function handleRequest(request, env, ctx, fetchImpl = fetch) {
  if (!env.APP_ORIGIN || !env.ACCESS_AUD || !ctx?.access) return json({ error: "access_required" }, 401);
  if (ctx.access.aud !== env.ACCESS_AUD) return json({ error: "access_audience_mismatch" }, 401);
  let identity;
  try { identity = await ctx.access.getIdentity(); } catch { return json({ error: "access_required" }, 401); }
  if (identity?.email?.toLowerCase() !== OWNER_EMAIL) return json({ error: "forbidden" }, 403);

  let upstream;
  try { upstream = createUpstreamRequest(request, env.APP_ORIGIN); } catch {
    return json({ error: "proxy_not_configured" }, 503);
  }
  try { return await fetchImpl(upstream); } catch {
    return json({ error: "app_unavailable" }, 502);
  }
}

export default { fetch: handleRequest };
