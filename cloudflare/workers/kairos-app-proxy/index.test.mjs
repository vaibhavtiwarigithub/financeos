import test from "node:test";
import assert from "node:assert/strict";
import { createUpstreamRequest, handleRequest } from "./index.js";

const aud = "kairos-test-audience";
const assertion = "signed-access-assertion";

function request(path = "/dashboard", init = {}) {
  return new Request(`https://kairos-app-proxy.example.workers.dev${path}`, {
    ...init,
    headers: { "cf-access-jwt-assertion": assertion, ...(init.headers ?? {}) },
  });
}

function ctx(email = "vterminater@gmail.com", audience = aud) {
  return { access: { aud: audience, async getIdentity() { return { email }; } } };
}

test("fails closed when Cloudflare Access context or proxy configuration is absent", async () => {
  const req = request();
  assert.equal((await handleRequest(req, { APP_ORIGIN: "https://kairos-free-beta.onrender.com", ACCESS_AUD: aud }, {})).status, 401);
  assert.equal((await handleRequest(req, { ACCESS_AUD: aud }, ctx())).status, 401);
});

test("requires the configured Access audience and owner identity", async () => {
  const env = { APP_ORIGIN: "https://kairos-free-beta.onrender.com", ACCESS_AUD: aud };
  assert.equal((await handleRequest(request(), env, ctx("vterminater@gmail.com", "wrong-audience"))).status, 401);
  assert.equal((await handleRequest(request(), env, ctx("other@example.com"))).status, 403);
});

test("forwards requests to the fixed HTTPS origin with the signed Access assertion", async () => {
  const env = { APP_ORIGIN: "https://kairos-free-beta.onrender.com", ACCESS_AUD: aud };
  let forwarded;
  const response = await handleRequest(request("/api/user-watchlist?market=us", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ symbol: "AAPL" }),
  }), env, ctx(), async (upstream) => {
    forwarded = upstream;
    return new Response("proxied", { status: 201 });
  });
  assert.equal(response.status, 201);
  assert.equal(forwarded.url, "https://kairos-free-beta.onrender.com/api/user-watchlist?market=us");
  assert.equal(forwarded.method, "POST");
  assert.equal(forwarded.headers.get("cf-access-jwt-assertion"), assertion);
  assert.equal(forwarded.headers.get("x-forwarded-host"), "kairos-app-proxy.example.workers.dev");
  assert.deepEqual(await forwarded.json(), { symbol: "AAPL" });
});

test("rejects non-HTTPS or credential-bearing origins", () => {
  assert.throws(() => createUpstreamRequest(request(), "http://kairos.example.com"));
  assert.throws(() => createUpstreamRequest(request(), "https://user:pass@kairos.example.com"));
});
