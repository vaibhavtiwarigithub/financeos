import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "./index.js";

const token = "test-token-with-at-least-32-characters-long";
const userId = "abc12345-6789-4abc-8def-0123456789ab";

function makeEnv() {
  const calls = [];
  const DB = {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async all() {
              calls.push({ sql, params, method: "all" });
              return { results: [{ id: "row-1", symbol: "AAPL", market: "us", added_at: "2026-01-01T00:00:00.000Z" }] };
            },
            async run() {
              calls.push({ sql, params, method: "run" });
              return { success: true };
            },
          };
        },
      };
    },
  };
  return { env: { DB, KAIROS_GATEWAY_TOKEN: token }, calls };
}

function request(path, { method = "GET", body, authorization = `Bearer ${token}` } = {}) {
  return new Request(`https://db.kairos.invalid${path}`, {
    method,
    headers: { authorization, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("rejects unauthenticated, short, or wrong gateway tokens", async () => {
  const { env, calls } = makeEnv();
  for (const authorization of ["", "Bearer short", "Bearer wrong-token-with-at-least-32-characters-long"]) {
    const response = await handleRequest(request("/v1/user-watchlist", { authorization }), env);
    assert.equal(response.status, 401);
    assert.deepEqual(calls, []);
  }
});

test("lists only the requested user with a bounded parameterized query", async () => {
  const { env, calls } = makeEnv();
  const response = await handleRequest(request(`/v1/user-watchlist?user_id=${userId}`), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { items: [{ id: "row-1", symbol: "AAPL", market: "us", added_at: "2026-01-01T00:00:00.000Z" }] });
  assert.deepEqual(calls[0].params, [userId, 1000]);
  assert.match(calls[0].sql, /WHERE user_id = \? ORDER BY added_at DESC LIMIT \?/);
});

test("rejects malformed identifiers and unsupported markets before database access", async () => {
  const { env, calls } = makeEnv();
  const badUser = await handleRequest(request("/v1/user-watchlist?user_id=not-a-uuid"), env);
  const badMarket = await handleRequest(request("/v1/user-watchlist", { method: "POST", body: { user_id: userId, symbol: "AAPL", market: "other" } }), env);
  assert.equal(badUser.status, 400);
  assert.equal(badMarket.status, 400);
  assert.deepEqual(calls, []);
});

test("upserts normalized user-owned rows through bound parameters", async () => {
  const { env, calls } = makeEnv();
  const response = await handleRequest(request("/v1/user-watchlist", {
    method: "POST",
    body: { user_id: userId, symbol: " aapl ", market: "US" },
  }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, symbol: "AAPL", market: "us" });
  assert.equal(calls[0].method, "run");
  assert.deepEqual(calls[0].params.slice(1, 4), [userId, "AAPL", "us"]);
  assert.match(calls[0].sql, /ON CONFLICT\(user_id, symbol, market\) DO NOTHING/);
});

test("deletes only the requested user's exact symbol and market", async () => {
  const { env, calls } = makeEnv();
  const response = await handleRequest(request(`/v1/user-watchlist?user_id=${userId}&symbol=aapl&market=US`, { method: "DELETE" }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(calls[0].params, [userId, "AAPL", "us"]);
  assert.match(calls[0].sql, /WHERE user_id = \? AND symbol = \? AND market = \?/);
});

test("does not expose D1 errors and always disables response caching", async () => {
  const { env } = makeEnv();
  env.DB.prepare = () => ({ bind: () => ({ all: async () => { throw new Error("private SQL detail"); } }) });
  const response = await handleRequest(request(`/v1/user-watchlist?user_id=${userId}`), env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "database_unavailable" });
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});
