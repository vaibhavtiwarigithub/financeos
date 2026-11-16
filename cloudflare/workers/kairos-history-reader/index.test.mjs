import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "./index.js";

const token = "test-token-with-at-least-32-characters-long";
const row = { id: 1, symbol: "AAPL", market: "us", session_date: "2026-01-02", available_at_us: 1_767_312_000_000_001 };

function mockDb({ results = [row], rowsRead = results.length, sizeAfter = 17_715_200,
  dataset = { state: "verified", expected_rows: 261678, verified_rows: 261678 }, insertedRows = 1 } = {}) {
  const captured = { queries: [] };
  const datasetRow = { mirror_budget_day: null, mirror_rows_today: 0, ...dataset };
  const db = {
    captured,
    prepare(sql) {
      captured.queries.push(sql);
      const statement = {
        bind(...params) { captured.params = params; return statement; },
        async first() { return datasetRow; },
        async all() {
          captured.query = sql;
          return { success: true, results, meta: { rows_read: rowsRead, size_after: sizeAfter } };
        },
      };
      return statement;
    },
    async batch(statements) {
      captured.batchCount = statements.length;
      return statements.map((_, index) => ({ success: true, meta: { changes: index === 0 || index === statements.length - 1 || index % 2 === 0 ? 1 : insertedRows } }));
    },
  };
  return db;
}

function request(query = "market=us&since=2026-01-01&until=2026-01-31&symbol=AAPL", headers = { Authorization: `Bearer ${token}` }, method = "GET") {
  return new Request(`https://archive.test/v1/symbol-daily-returns?${query}`, { method, headers });
}

function statusRequest(headers = { Authorization: `Bearer ${token}` }) {
  return new Request("https://archive.test/v1/status", { headers });
}

function ingestRequest(rows, headers = { Authorization: `Bearer ${token}` }) {
  return new Request("https://archive.test/v1/symbol-daily-returns/ingest", {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ rows }),
  });
}

function indiaArchiveRequest(body, headers = {}) {
  const bytes = body instanceof Uint8Array ? body : new TextEncoder().encode(String(body));
  return new Request("https://archive.test/v1/archive/india-news-snapshots", {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/gzip", "Content-Length": String(bytes.byteLength),
      "X-Kairos-Cutoff": "2026-11-01T00:00:00.000Z", "X-Kairos-Row-Count": "2",
      "X-Kairos-Min-Id": "10", "X-Kairos-Max-Id": "11",
      "X-Kairos-Source-Digest": "80bff5cb61b3ad12093a1215eb340c32",
      "X-Kairos-Archive-Sha256": "a".repeat(64), ...headers }, body: bytes,
  });
}

function mockR2({ truncated = false } = {}) {
  const objects = new Map();
  return {
    objects,
    async head(key) { return objects.get(key) ?? null; },
    async put(key, value, options = {}) {
      const body = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(await new Response(value).arrayBuffer());
      objects.set(key, { size: body.byteLength, customMetadata: options.customMetadata ?? {}, httpMetadata: options.httpMetadata ?? {}, body });
    },
    async list() { return { objects: [...objects.entries()].map(([key, value]) => ({ key, size: value.size })), truncated }; },
    async get(key) {
      const stored = objects.get(key);
      if (!stored) return null;
      return { size: stored.size, body: new Response(stored.body).body, httpEtag: '"etag"',
        writeHttpMetadata(headers) { for (const [name, value] of Object.entries(stored.httpMetadata)) headers.set(name, value); } };
    },
  };
}

const ingestRow = {
  id: 4256042, symbol: "AAPL", market: "us", session_date: "2026-01-02", previous_session_date: "2026-01-01",
  available_at: "2026-01-02T00:00:00.123456Z", source: "massive", price_basis: "adjusted_close",
  close: 100.125, previous_close: 99.5, simple_return: 0.006281407035175879,
  input_fingerprint: "test-fingerprint", created_at: "2026-01-02T00:00:01.000000Z",
};

test("requires a valid server token and only accepts GET on the exact route", async () => {
  const db = mockDb();
  assert.equal((await handleRequest(request("market=us&since=2026-01-01&until=2026-01-31", {}), { DB: db, KAIROS_ARCHIVE_READER_TOKEN: token })).status, 401);
  assert.equal((await handleRequest(request("market=us&since=2026-01-01&until=2026-01-31", { Authorization: `Bearer ${token}x` }), { DB: db, KAIROS_ARCHIVE_READER_TOKEN: token })).status, 401);
  assert.equal((await handleRequest(request("", { Authorization: `Bearer ${token}` }, "POST"), { DB: db, KAIROS_ARCHIVE_READER_TOKEN: token })).status, 405);
  assert.equal((await handleRequest(new Request("https://archive.test/other", { headers: { Authorization: `Bearer ${token}` } }), { DB: db, KAIROS_ARCHIVE_READER_TOKEN: token })).status, 404);
  assert.equal((await handleRequest(request(), { DB: db })).status, 503);
});

test("reports authenticated D1 size and verified row state without exposing row data", async () => {
  const db = mockDb({ sizeAfter: 17_715_200 });
  const archive = { async list() { return { objects: [{ key: "opaque-object-key", size: 100 }], truncated: false }; } };
  const response = await handleRequest(statusRequest(), { DB: db, ARCHIVE: archive, KAIROS_ARCHIVE_READER_TOKEN: token });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    dataset: { state: "verified", expected_rows: 261678, verified_rows: 261678, verified_at: null,
      mirrorBudgetDay: null, mirrorRowsToday: 0, mirrorRowsDailyLimit: 15000 },
    d1Bytes: 17_715_200, databaseLimitBytes: 500_000_000, remainingDatabaseBytes: 482_284_800,
    r2ObjectCount: 1, r2BytesConservative: 8_292, r2BudgetBytes: 8_000_000_000, r2RemainingBytes: 7_999_991_708,
  });
  assert.match(db.captured.query, /SELECT 1 AS ok/);
});

test("refuses incomplete or oversized R2 inventories instead of reporting a false safe status", async () => {
  const db = mockDb();
  const missingCursor = { async list() { return { objects: [], truncated: true }; } };
  const response = await handleRequest(statusRequest(), { DB: db, ARCHIVE: missingCursor, KAIROS_ARCHIVE_READER_TOKEN: token });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "r2_inventory_exceeds_monitor_bound" });
});

test("ingests validated new rows atomically and updates mirror counts only after insert", async () => {
  const db = mockDb({ dataset: { state: "verified", expected_rows: 261678, verified_rows: 261678 }, insertedRows: 1 });
  const response = await handleRequest(ingestRequest([ingestRow]), { DB: db, KAIROS_ARCHIVE_READER_TOKEN: token });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accepted: 1, inserted: 1 });
  assert.equal(db.captured.batchCount, 4);
  assert.ok(db.captured.queries.some(sql => sql.includes("verified_rows=verified_rows+changes()")));
  assert.ok(db.captured.queries.some(sql => sql.includes("mirror_rows_today=mirror_rows_today-1+changes()")));
});

test("enforces the daily mirror intake budget before reserving D1 writes", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const db = mockDb({ dataset: { state: "verified", expected_rows: 261678, verified_rows: 261678,
    mirror_budget_day: today, mirror_rows_today: 14995 } });
  const rows = Array.from({ length: 10 }, (_, index) => ({ ...ingestRow, id: ingestRow.id + index }));
  const response = await handleRequest(ingestRequest(rows), { DB: db, KAIROS_ARCHIVE_READER_TOKEN: token });
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: "archive_daily_write_budget_exceeded", dailyRowLimit: 15000, rowsAcceptedToday: 14995 });
  assert.equal(db.captured.batchCount, undefined);
});

test("refuses a concurrent daily-budget reservation when the atomic D1 guard loses a race", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const db = mockDb({ dataset: { state: "verified", expected_rows: 261678, verified_rows: 261678,
    mirror_budget_day: today, mirror_rows_today: 14980 } });
  db.batch = async statements => {
    db.captured.batchCount = statements.length;
    return statements.map(() => ({ success: true, meta: { changes: 0 } }));
  };
  const rows = Array.from({ length: 10 }, (_, index) => ({ ...ingestRow, id: ingestRow.id + index }));
  const response = await handleRequest(ingestRequest(rows), { DB: db, KAIROS_ARCHIVE_READER_TOKEN: token });
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: "archive_daily_write_budget_race", dailyRowLimit: 15000 });
});

test("rejects invalid or unverified writes before any D1 batch", async () => {
  const unverifiedDb = mockDb({ dataset: { state: "loading", expected_rows: 261678, verified_rows: 99000 } });
  const blocked = await handleRequest(ingestRequest([ingestRow]), { DB: unverifiedDb, KAIROS_ARCHIVE_READER_TOKEN: token });
  assert.equal(blocked.status, 503);
  assert.equal(unverifiedDb.captured.batchCount, undefined);
  const invalidDb = mockDb();
  const invalid = await handleRequest(ingestRequest([{ ...ingestRow, available_at: "2026-01-02T00:00:00.1234567Z" }]),
    { DB: invalidDb, KAIROS_ARCHIVE_READER_TOKEN: token });
  assert.equal(invalid.status, 400);
  assert.equal(invalidDb.captured.batchCount, undefined);
});

test("acknowledges idempotent duplicate inserts without inflating verified counts", async () => {
  const db = mockDb({ insertedRows: 0 });
  const response = await handleRequest(ingestRequest([ingestRow]), { DB: db, KAIROS_ARCHIVE_READER_TOKEN: token });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accepted: 1, inserted: 0 });
});

test("validates bounds and binds all query values instead of interpolating user input", async () => {
  const db = mockDb();
  const invalid = [
    "market=other&since=2026-01-01&until=2026-01-31",
    "market=us&since=2026-02-01&until=2026-01-01",
    "market=us&since=2010-01-01&until=2026-01-01",
    "market=us&since=2026-01-01&until=2026-01-31&limit=5001",
    "market=us&since=2026-01-01&until=2026-01-31&symbol=AAPL%27%20OR%201%3D1",
    "market=us&since=2026-01-01&until=2026-01-31",
  ];
  for (const query of invalid) assert.equal((await handleRequest(request(query), { DB: db, KAIROS_ARCHIVE_READER_TOKEN: token })).status, 400);
  const response = await handleRequest(request("market=us&since=2026-01-01&until=2026-01-31&symbol=AAPL"), { DB: db, KAIROS_ARCHIVE_READER_TOKEN: token });
  assert.equal(response.status, 200);
  assert.ok(!db.captured.query.includes("AAPL"));
  assert.deepEqual(db.captured.params, ["us", "2026-01-01", "2026-01-31", "AAPL", 1000, 0]);
});

test("India snapshot archive writes immutable private objects and supports authenticated read-back", async () => {
  const env = { DB: mockDb(), ARCHIVE: mockR2(), KAIROS_ARCHIVE_READER_TOKEN: token };
  const upload = await handleRequest(indiaArchiveRequest(new Uint8Array([1, 2, 3])), env);
  assert.equal(upload.status, 200);
  const manifest = await upload.json();
  assert.equal(manifest.rowCount, 2);
  assert.equal(manifest.sourceDigest, "80bff5cb61b3ad12093a1215eb340c32");
  assert.equal(env.ARCHIVE.objects.size, 2);

  const archiveRead = await handleRequest(new Request(`https://archive.test/v1/archive/india-news-snapshots/${manifest.sourceDigest}/${manifest.archiveSha256}`, {
    headers: { Authorization: `Bearer ${token}` },
  }), env);
  assert.equal(archiveRead.status, 200);
  assert.deepEqual([...new Uint8Array(await archiveRead.arrayBuffer())], [1, 2, 3]);

  const manifestRead = await handleRequest(new Request(`https://archive.test/v1/archive/india-news-snapshots/${manifest.sourceDigest}/${manifest.archiveSha256}/manifest`, {
    headers: { Authorization: `Bearer ${token}` },
  }), env);
  assert.equal(manifestRead.status, 200);
  assert.equal((await manifestRead.json()).archiveBytes, 3);
  const repeated = await handleRequest(indiaArchiveRequest(new Uint8Array([1, 2, 3])), env);
  assert.equal(repeated.status, 200);
  assert.equal(env.ARCHIVE.objects.size, 2);
});

test("India snapshot archive rejects bad manifests, oversized uploads, and incomplete capacity inventories", async () => {
  const env = { DB: mockDb(), ARCHIVE: mockR2(), KAIROS_ARCHIVE_READER_TOKEN: token };
  assert.equal((await handleRequest(indiaArchiveRequest("x", { "X-Kairos-Source-Digest": "bad" }), env)).status, 400);
  assert.equal((await handleRequest(indiaArchiveRequest(new Uint8Array(25_000_001)), env)).status, 400);
  const boundedEnv = { ...env, ARCHIVE: mockR2({ truncated: true }) };
  assert.equal((await handleRequest(indiaArchiveRequest(new Uint8Array([1])), boundedEnv)).status, 507);
  assert.equal(boundedEnv.ARCHIVE.objects.size, 0);
});

test("requires symbol filters so every archive query can use the bounded lookup index", async () => {
  const db = mockDb();
  const response = await handleRequest(request("market=us&since=2026-01-01&until=2026-01-31"),
    { DB: db, KAIROS_ARCHIVE_READER_TOKEN: token });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "symbols_required" });
  assert.equal(db.captured.queries.length, 0);
});

test("allows only the explicit bounded, indexed market-wide policy-event scan", async () => {
  const db = mockDb();
  const response = await handleRequest(request("market=us&since=2026-01-01&until=2026-01-31&marketWide=true&sort=available_at_desc"),
    { DB: db, KAIROS_ARCHIVE_READER_TOKEN: token });
  assert.equal(response.status, 200);
  assert.match(db.captured.query, /market = \? AND session_date >= \? AND session_date <= \?/);
  assert.doesNotMatch(db.captured.query, /symbol IN/);
  const invalidSort = await handleRequest(request("market=us&since=2026-01-01&until=2026-01-31&marketWide=true"),
    { DB: mockDb(), KAIROS_ARCHIVE_READER_TOKEN: token });
  assert.equal(invalidSort.status, 400);
  assert.deepEqual(await invalidSort.json(), { error: "invalid_market_wide_sort" });
});

test("keeps rotation-without-symbols error specific to the existing RPC contract", async () => {
  const response = await handleRequest(request("market=us&since=2026-01-01&until=2026-01-31&mode=rotation"),
    { DB: mockDb(), KAIROS_ARCHIVE_READER_TOKEN: token });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "rotation_requires_symbols" });
});

test("implements point-in-time filtering and rotation latest-row semantics with bounded pages", async () => {
  const db = mockDb({ results: [row], rowsRead: 8 });
  const query = "market=us&since=2026-01-01&until=2026-01-31&symbol=AAPL&symbol=MSFT&availableAtOrBefore=2026-01-02T00%3A00%3A00.000Z&mode=rotation&limit=2&offset=4";
  const result = await handleRequest(request(query), { DB: db, KAIROS_ARCHIVE_READER_TOKEN: token });
  assert.equal(result.status, 200);
  assert.match(db.captured.query, /ROW_NUMBER\(\) OVER \(PARTITION BY symbol,session_date ORDER BY available_at_us DESC,id DESC\)/);
  assert.deepEqual(db.captured.params.slice(0, 6), ["us", "2026-01-01", "2026-01-31", "AAPL", "MSFT", 1767312000000000]);
  assert.deepEqual(db.captured.params.slice(-2), [2, 4]);
});

test("keeps rotation symbol count within the Postgres RPC contract", async () => {
  const db = mockDb();
  const symbols = Array.from({ length: 21 }, (_, index) => `S${index}`).join("&symbol=");
  const response = await handleRequest(request(`market=us&since=2026-01-01&until=2026-01-31&mode=rotation&symbol=${symbols}`),
    { DB: db, KAIROS_ARCHIVE_READER_TOKEN: token });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "too_many_rotation_symbols" });
  assert.equal(db.captured.queries.length, 0);
});

test("preserves microsecond precision in point-in-time cutoffs", async () => {
  const db = mockDb();
  const query = "market=us&since=2026-01-01&until=2026-01-31&symbol=AAPL&availableAtOrBefore=2026-01-02T00%3A00%3A00.123456Z";
  const response = await handleRequest(request(query), { DB: db, KAIROS_ARCHIVE_READER_TOKEN: token });
  assert.equal(response.status, 200);
  assert.equal(db.captured.params[4], 1_767_312_000_123_456);
});

test("returns explicit degraded status when the D1 read budget guard trips", async () => {
  const db = mockDb({ results: [row], rowsRead: 400_001 });
  const result = await handleRequest(request(), { DB: db, KAIROS_ARCHIVE_READER_TOKEN: token });
  assert.equal(result.status, 503);
  assert.deepEqual(await result.json(), { error: "archive_query_budget_exceeded" });
});

test("fails closed until the entire imported dataset is parity-verified", async () => {
  const db = mockDb({ dataset: { state: "loading", expected_rows: 261678, verified_rows: 99000 } });
  const response = await handleRequest(request(), { DB: db, KAIROS_ARCHIVE_READER_TOKEN: token });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "archive_dataset_not_verified" });
  assert.equal(db.captured.queries.length, 1);
});
