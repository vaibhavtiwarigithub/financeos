const PATH = "/v1/symbol-daily-returns";
const INGEST_PATH = "/v1/symbol-daily-returns/ingest";
const STATUS_PATH = "/v1/status";
const INDIA_NEWS_ARCHIVE_PATH = "/v1/archive/india-news-snapshots";
const PAGE_SIZE = 5_000;
const MAX_OFFSET = 500_000;
const MAX_SYMBOLS = 250;
const MAX_ROWS_READ = 400_000;
// One composite secondary index adds one D1 write per inserted data row. The
// endpoint also updates the status row while keeping exact mirror counts, so
// cap the source-row intake well below 100k to reserve Free-tier write headroom.
const MAX_MIRROR_ROWS_PER_DAY = 15_000;
const MAX_R2_OBJECTS_PER_STATUS = 1_000;
const R2_ACCOUNT_BUDGET_BYTES = 8_000_000_000;
const R2_OBJECT_METADATA_BUDGET_BYTES = 8_192;
const INDIA_NEWS_ARCHIVE_MAX_BYTES = 25_000_000;
const R2_UPLOAD_STOP_BYTES = 7_500_000_000;
const SELECT_COLUMNS = "id,symbol,market,session_date,previous_session_date,available_at,available_at_us,source,price_basis,close,previous_close,simple_return,input_fingerprint,created_at";
const INSERT_COLUMNS = SELECT_COLUMNS;

function json(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}

function secureEqual(expected, actual) {
  const encoder = new TextEncoder();
  const left = encoder.encode(expected);
  const right = encoder.encode(actual);
  if (left.length !== right.length || left.length < 32) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

function parseDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

function parseAvailableAt(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const wholeSeconds = Date.parse(`${match[1]}${match[3]}`);
  if (!Number.isFinite(wholeSeconds)) return null;
  const micros = Number((match[2] ?? "").padEnd(6, "0") || "0");
  return wholeSeconds * 1000 + micros;
}

function parseRequest(url) {
  const market = url.searchParams.get("market");
  const since = parseDate(url.searchParams.get("since"));
  const until = parseDate(url.searchParams.get("until"));
  const mode = url.searchParams.get("mode") ?? "raw";
  const sort = url.searchParams.get("sort") ?? "id_asc";
  const marketWideText = url.searchParams.get("marketWide");
  const marketWide = marketWideText === "true";
  const limit = Number(url.searchParams.get("limit") ?? 1000);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const symbols = [...new Set(url.searchParams.getAll("symbol").flatMap(value => value.split(","))
    .map(value => value.trim().toUpperCase()).filter(Boolean))];
  const availableAtOrBefore = parseAvailableAt(url.searchParams.get("availableAtOrBefore"));
  if (market !== "us" && market !== "india") return { error: "invalid_market" };
  if (!since || !until || since > until) return { error: "invalid_date_range" };
  const days = (Date.parse(`${until}T00:00:00.000Z`) - Date.parse(`${since}T00:00:00.000Z`)) / 86_400_000;
  if (days > 3660) return { error: "date_range_too_wide" };
  if (mode !== "raw" && mode !== "rotation") return { error: "invalid_mode" };
  if (marketWideText !== null && marketWideText !== "true") return { error: "invalid_market_wide" };
  if (!new Set(["id_asc", "available_at_asc", "available_at_desc"]).has(sort)) return { error: "invalid_sort" };
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_SIZE) return { error: "invalid_limit" };
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_OFFSET) return { error: "invalid_offset" };
  if (symbols.length > MAX_SYMBOLS || symbols.some(symbol => !/^[A-Z0-9.^_=-]{1,32}$/.test(symbol))) return { error: "invalid_symbols" };
  if (mode === "rotation" && symbols.length === 0) return { error: "rotation_requires_symbols" };
  if (marketWide && (mode !== "raw" || symbols.length > 0)) return { error: "invalid_market_wide" };
  if (marketWide && sort !== "available_at_desc") return { error: "invalid_market_wide_sort" };
  if (!marketWide && symbols.length === 0) return { error: "symbols_required" };
  // Match get_rotation_return_cohort(p_market, p_symbols, p_since): callers
  // may request at most twenty symbols. Keeping that contract here prevents
  // the archive path from accepting a wider query than the Postgres path.
  if (mode === "rotation" && symbols.length > 20) return { error: "too_many_rotation_symbols" };
  if (marketWide && offset > 50_000) return { error: "market_wide_offset_too_large" };
  return { value: { market, since, until, mode, sort, limit, offset, symbols, availableAtOrBefore, marketWide } };
}

function buildQuery(filters) {
  const clauses = ["market = ?", "session_date >= ?", "session_date <= ?"];
  const params = [filters.market, filters.since, filters.until];
  if (filters.symbols.length) {
    clauses.push(`symbol IN (${filters.symbols.map(() => "?").join(",")})`);
    params.push(...filters.symbols);
  }
  if (filters.availableAtOrBefore !== null) {
    clauses.push("available_at_us <= ?");
    params.push(filters.availableAtOrBefore);
  }
  const where = clauses.join(" AND ");
  if (filters.mode === "rotation") {
    return {
      sql: `WITH ranked AS (SELECT ${SELECT_COLUMNS},ROW_NUMBER() OVER (PARTITION BY symbol,session_date ORDER BY available_at_us DESC,id DESC) AS rn FROM symbol_daily_returns WHERE ${where}) SELECT ${SELECT_COLUMNS} FROM ranked WHERE rn=1 ORDER BY symbol ASC,session_date ASC LIMIT ? OFFSET ?`,
      params: [...params, filters.limit, filters.offset],
    };
  }
  const order = filters.sort === "available_at_asc" ? "available_at_us ASC,id ASC"
    : filters.sort === "available_at_desc" ? "available_at_us DESC,id DESC" : "id ASC";
  return { sql: `SELECT ${SELECT_COLUMNS} FROM symbol_daily_returns WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
    params: [...params, filters.limit, filters.offset] };
}

async function readBoundedJson(request, maxBytes = 250_000) {
  if (!request.body) throw new Error("missing_body");
  const reader = request.body.getReader();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new Error("body_too_large");
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined));
}

function validateIngestRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const id = Number(row.id);
  const symbol = row.symbol;
  const market = row.market;
  const sessionDate = row.session_date;
  const previousDate = row.previous_session_date;
  const availableAt = row.available_at;
  const source = row.source;
  const priceBasis = row.price_basis;
  const close = typeof row.close === "number" && Number.isFinite(row.close) ? String(row.close) : row.close;
  const previousClose = typeof row.previous_close === "number" && Number.isFinite(row.previous_close) ? String(row.previous_close) : row.previous_close;
  const simpleReturn = typeof row.simple_return === "number" && Number.isFinite(row.simple_return) ? String(row.simple_return) : row.simple_return;
  const fingerprint = row.input_fingerprint;
  const createdAt = row.created_at;
  const availableAtUs = parseAvailableAt(availableAt);
  const decimal = value => typeof value === "string" && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value);
  if (!Number.isSafeInteger(id) || id <= 0 || typeof symbol !== "string" || !/^[A-Z0-9.^_=-]{1,32}$/.test(symbol)
    || !["us", "india"].includes(market) || !parseDate(sessionDate) || !parseDate(previousDate) || previousDate >= sessionDate
    || availableAtUs === null || !Number.isSafeInteger(availableAtUs) || typeof source !== "string" || source.length < 1 || source.length > 80
    || !["adjusted_close", "raw_close"].includes(priceBasis) || !decimal(close) || Number(close) <= 0
    || !decimal(previousClose) || Number(previousClose) <= 0 || !decimal(simpleReturn) || Number(simpleReturn) <= -1
    || typeof fingerprint !== "string" || fingerprint.length < 1 || fingerprint.length > 256 || fingerprint.includes("\0")
    || typeof createdAt !== "string" || parseAvailableAt(createdAt) === null) return null;
  return [id, symbol, market, sessionDate, previousDate, availableAt, availableAtUs, source, priceBasis,
    close, previousClose, simpleReturn, fingerprint, createdAt];
}

async function ingestRows(request, env) {
  let payload;
  try { payload = await readBoundedJson(request); }
  catch { return json({ error: "invalid_ingest_body" }, 400); }
  if (!payload || !Array.isArray(payload.rows) || payload.rows.length < 1 || payload.rows.length > 10) {
    return json({ error: "invalid_ingest_rows" }, 400);
  }
  const rows = payload.rows.map(validateIngestRow);
  if (rows.some(row => row === null) || new Set(rows.map(row => row[0])).size !== rows.length) {
    return json({ error: "invalid_ingest_rows" }, 400);
  }
  const state = await env.DB.prepare("SELECT expected_rows,verified_rows,state,mirror_budget_day,mirror_rows_today FROM archive_dataset_status WHERE dataset=?")
    .bind("symbol_daily_returns_v1").first();
  if (!state || state.state !== "verified" || state.expected_rows !== state.verified_rows) {
    return json({ error: "archive_dataset_not_verified" }, 503);
  }
  const budget = state;
  if (!budget || !Number.isSafeInteger(budget.mirror_rows_today) || budget.mirror_rows_today < 0
    || (budget.mirror_budget_day !== null && typeof budget.mirror_budget_day !== "string")) {
    return json({ error: "archive_write_budget_unavailable" }, 503);
  }
  const today = new Date().toISOString().slice(0, 10);
  const usedToday = budget.mirror_budget_day === today ? budget.mirror_rows_today : 0;
  if (usedToday + rows.length > MAX_MIRROR_ROWS_PER_DAY) {
    return json({ error: "archive_daily_write_budget_exceeded", dailyRowLimit: MAX_MIRROR_ROWS_PER_DAY,
      rowsAcceptedToday: usedToday }, 429);
  }
  try {
    const statements = [];
    const placeholders = `(${INSERT_COLUMNS.split(",").map(() => "?").join(",")})`;
    // Reserve the complete request atomically before inserts. Concurrent mirror
    // calls cannot oversubscribe the daily source-row budget; duplicates release
    // their reservation in the per-row status update below.
    statements.push(env.DB.prepare("UPDATE archive_dataset_status SET state='degraded',mirror_budget_day=date('now'),mirror_rows_today=CASE WHEN mirror_budget_day=date('now') THEN mirror_rows_today ELSE 0 END+? WHERE dataset=? AND state='verified' AND verified_rows=expected_rows AND (mirror_budget_day IS NULL OR mirror_budget_day<>date('now') OR mirror_rows_today+?<=?)")
      .bind(rows.length, "symbol_daily_returns_v1", rows.length, MAX_MIRROR_ROWS_PER_DAY));
    for (const values of rows) {
      statements.push(env.DB.prepare(`INSERT OR IGNORE INTO symbol_daily_returns (${INSERT_COLUMNS}) SELECT ${placeholders.slice(1, -1).split(",").join(",")} WHERE EXISTS(SELECT 1 FROM archive_dataset_status WHERE dataset='symbol_daily_returns_v1' AND state='degraded')`)
        .bind(...values));
      statements.push(env.DB.prepare("UPDATE archive_dataset_status SET verified_rows=verified_rows+changes(),expected_rows=expected_rows+changes(),mirror_rows_today=mirror_rows_today-1+changes() WHERE dataset=? AND state='degraded' AND mirror_budget_day=date('now')")
        .bind("symbol_daily_returns_v1"));
    }
    statements.push(env.DB.prepare("UPDATE archive_dataset_status SET state='verified',verified_at=CURRENT_TIMESTAMP WHERE dataset=? AND state='degraded' AND verified_rows=expected_rows")
      .bind("symbol_daily_returns_v1"));
    const results = await env.DB.batch(statements);
    if (results?.[0]?.meta?.changes === 0) {
      return json({ error: "archive_daily_write_budget_race", dailyRowLimit: MAX_MIRROR_ROWS_PER_DAY }, 429);
    }
    if (!Array.isArray(results) || results.length !== statements.length
      || results.some((result, index) => result.success === false
        || ([0, results.length - 1, ...rows.map((_, rowIndex) => rowIndex * 2 + 2)].includes(index) && result.meta?.changes !== 1))) {
      return json({ error: "archive_ingest_failed" }, 503);
    }
    const inserted = rows.reduce((sum, _, rowIndex) => sum + Number(results[rowIndex * 2 + 1].meta?.changes ?? 0), 0);
    return json({ accepted: rows.length, inserted }, 200);
  } catch {
    return json({ error: "archive_ingest_failed" }, 503);
  }
}

function parseArchiveHeaders(request) {
  const cutoff = request.headers.get("X-Kairos-Cutoff") ?? "";
  const rowCount = Number(request.headers.get("X-Kairos-Row-Count"));
  const minId = Number(request.headers.get("X-Kairos-Min-Id"));
  const maxId = Number(request.headers.get("X-Kairos-Max-Id"));
  const sourceDigest = request.headers.get("X-Kairos-Source-Digest") ?? "";
  const archiveSha256 = request.headers.get("X-Kairos-Archive-Sha256") ?? "";
  const archiveBytes = Number(request.headers.get("Content-Length"));
  const cutoffTime = Date.parse(cutoff);
  if (!Number.isFinite(cutoffTime) || new Date(cutoffTime).toISOString() !== cutoff
    || cutoffTime > Date.now() - 7 * 86_400_000
    || !Number.isSafeInteger(rowCount) || rowCount < 1 || rowCount > 10_000
    || !Number.isSafeInteger(minId) || minId < 1 || !Number.isSafeInteger(maxId) || maxId < minId
    || !/^[0-9a-f]{32}$/.test(sourceDigest) || !/^[0-9a-f]{64}$/.test(archiveSha256)
    || !Number.isSafeInteger(archiveBytes) || archiveBytes < 1 || archiveBytes > INDIA_NEWS_ARCHIVE_MAX_BYTES
    || request.headers.get("Content-Type") !== "application/gzip") return null;
  return { cutoff, rowCount, minId, maxId, sourceDigest, archiveSha256, archiveBytes };
}

function indiaNewsObjectKeys(sourceDigest, archiveSha256) {
  const leaf = `india-news-snapshots-v1/${sourceDigest}/${archiveSha256}`;
  return { archiveKey: `table-archives/${leaf}.ndjson.gz`, manifestKey: `table-archives/${leaf}.manifest.json` };
}

function archiveMetadataMatches(object, metadata) {
  const stored = object?.customMetadata;
  return !!stored && stored.sourceDigest === metadata.sourceDigest
    && stored.archiveSha256 === metadata.archiveSha256
    && stored.rowCount === String(metadata.rowCount)
    && stored.minId === String(metadata.minId) && stored.maxId === String(metadata.maxId)
    && stored.cutoff === metadata.cutoff && object.size === metadata.archiveBytes;
}

async function r2CapacityAllows(env, additionalBytes, additionalObjects) {
  let cursor;
  let objectCount = 0;
  let conservativeBytes = 0;
  do {
    const page = await env.ARCHIVE.list({ limit: 1000, cursor });
    if (!Array.isArray(page.objects) || typeof page.truncated !== "boolean") return false;
    for (const object of page.objects) {
      if (!Number.isSafeInteger(object.size) || object.size < 0) return false;
      objectCount++;
      conservativeBytes += object.size + R2_OBJECT_METADATA_BUDGET_BYTES;
      if (!Number.isSafeInteger(conservativeBytes) || objectCount > MAX_R2_OBJECTS_PER_STATUS) return false;
    }
    cursor = page.truncated ? page.cursor : undefined;
    if (page.truncated && !cursor) return false;
  } while (cursor);
  return objectCount + additionalObjects <= MAX_R2_OBJECTS_PER_STATUS
    && conservativeBytes + additionalBytes + additionalObjects * R2_OBJECT_METADATA_BUDGET_BYTES <= R2_UPLOAD_STOP_BYTES;
}

async function archiveIndiaNewsSnapshots(request, env) {
  if (!env.ARCHIVE || !request.body) return json({ error: "archive_upload_unavailable" }, 503);
  const metadata = parseArchiveHeaders(request);
  if (!metadata) return json({ error: "invalid_archive_manifest" }, 400);
  const { archiveKey, manifestKey } = indiaNewsObjectKeys(metadata.sourceDigest, metadata.archiveSha256);
  try {
    let archived = await env.ARCHIVE.head(archiveKey);
    const archiveAlreadyExisted = !!archived;
    if (archived && !archiveMetadataMatches(archived, metadata)) return json({ error: "archive_object_conflict" }, 409);
    if (!archived) {
      if (!await r2CapacityAllows(env, metadata.archiveBytes, 2)) return json({ error: "r2_upload_budget_exceeded" }, 507);
      await env.ARCHIVE.put(archiveKey, request.body, {
        onlyIf: new Headers({ "If-None-Match": "*" }),
        // Preserve the compressed bytes as a raw gzip object so fetch clients
        // can verify the exact R2 representation without HTTP auto-decoding.
        httpMetadata: { contentType: "application/gzip" },
        customMetadata: { sourceDigest: metadata.sourceDigest, archiveSha256: metadata.archiveSha256,
          rowCount: String(metadata.rowCount), minId: String(metadata.minId), maxId: String(metadata.maxId), cutoff: metadata.cutoff },
      });
      archived = await env.ARCHIVE.head(archiveKey);
      if (!archiveMetadataMatches(archived, metadata)) return json({ error: "archive_upload_verification_failed" }, 503);
    }

    const manifest = {
      schemaVersion: 1, dataset: "india_news_snapshots", format: "gzip-compressed-ndjson",
      archiveKey, rowCount: metadata.rowCount, minId: metadata.minId, maxId: metadata.maxId,
      cutoff: metadata.cutoff, sourceDigest: metadata.sourceDigest,
      archiveSha256: metadata.archiveSha256, archiveBytes: metadata.archiveBytes,
    };
    const manifestBytes = JSON.stringify(manifest);
    const currentManifest = await env.ARCHIVE.head(manifestKey);
    if (currentManifest) {
      if (currentManifest.customMetadata?.archiveSha256 !== metadata.archiveSha256
        || currentManifest.customMetadata?.sourceDigest !== metadata.sourceDigest) return json({ error: "archive_manifest_conflict" }, 409);
    } else {
      if (archiveAlreadyExisted && !await r2CapacityAllows(env, 0, 1)) return json({ error: "r2_upload_budget_exceeded" }, 507);
      await env.ARCHIVE.put(manifestKey, manifestBytes, {
        onlyIf: new Headers({ "If-None-Match": "*" }),
        httpMetadata: { contentType: "application/json" },
        customMetadata: { sourceDigest: metadata.sourceDigest, archiveSha256: metadata.archiveSha256 },
      });
    }
    return json(manifest);
  } catch {
    return json({ error: "archive_upload_failed" }, 503);
  }
}

async function readIndiaNewsArchive(url, env) {
  if (!env.ARCHIVE) return json({ error: "archive_reader_unavailable" }, 503);
  const match = url.pathname.match(/^\/v1\/archive\/india-news-snapshots\/([0-9a-f]{32})\/([0-9a-f]{64})(\/manifest)?$/);
  if (!match) return json({ error: "not_found" }, 404);
  const { archiveKey, manifestKey } = indiaNewsObjectKeys(match[1], match[2]);
  try {
    const isManifest = !!match[3];
    const object = await env.ARCHIVE.get(isManifest ? manifestKey : archiveKey);
    if (!object || object.size > (isManifest ? 64_000 : INDIA_NEWS_ARCHIVE_MAX_BYTES)) return json({ error: "archive_object_unavailable" }, 404);
    const headers = new Headers({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
    object.writeHttpMetadata(headers);
    headers.set("ETag", object.httpEtag);
    return new Response(object.body, { status: 200, headers });
  } catch {
    return json({ error: "archive_object_unavailable" }, 503);
  }
}

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  const archiveRead = url.pathname.startsWith(`${INDIA_NEWS_ARCHIVE_PATH}/`);
  if (![PATH, STATUS_PATH, INGEST_PATH, INDIA_NEWS_ARCHIVE_PATH].includes(url.pathname) && !archiveRead) return json({ error: "not_found" }, 404);
  if (url.pathname === INGEST_PATH || url.pathname === INDIA_NEWS_ARCHIVE_PATH ? request.method !== "POST"
    : archiveRead || url.pathname === PATH || url.pathname === STATUS_PATH ? request.method !== "GET" : true) return json({ error: "method_not_allowed" }, 405);
  const expected = env.KAIROS_ARCHIVE_READER_TOKEN;
  if (typeof expected !== "string" || expected.length < 32 || !env.DB) return json({ error: "archive_reader_unavailable" }, 503);
  const authorization = request.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ") || !secureEqual(expected, authorization.slice(7))) return json({ error: "unauthorized" }, 401);
  if (url.pathname === INGEST_PATH) return ingestRows(request, env);
  if (url.pathname === INDIA_NEWS_ARCHIVE_PATH) return archiveIndiaNewsSnapshots(request, env);
  if (archiveRead) return readIndiaNewsArchive(url, env);
  if (url.pathname === STATUS_PATH) {
    try {
      const dataset = await env.DB.prepare("SELECT expected_rows,verified_rows,state,verified_at,mirror_budget_day,mirror_rows_today FROM archive_dataset_status WHERE dataset=?")
        .bind("symbol_daily_returns_v1").first();
      const ping = await env.DB.prepare("SELECT 1 AS ok").all();
      if (ping.success === false || !Number.isSafeInteger(ping.meta?.size_after) || !env.ARCHIVE
        || !dataset || !Number.isSafeInteger(dataset.expected_rows) || !Number.isSafeInteger(dataset.verified_rows)
        || !Number.isSafeInteger(dataset.mirror_rows_today) || dataset.mirror_rows_today < 0
        || (dataset.mirror_budget_day !== null && typeof dataset.mirror_budget_day !== "string")) {
        return json({ error: "archive_status_unavailable" }, 503);
      }
      let r2ObjectCount = 0;
      let r2BytesConservative = 0;
      const page = await env.ARCHIVE.list({ limit: MAX_R2_OBJECTS_PER_STATUS });
      if (!Array.isArray(page.objects) || typeof page.truncated !== "boolean" || page.truncated) {
        return json({ error: "r2_inventory_exceeds_monitor_bound" }, 503);
      }
      for (const object of page.objects) {
        if (!Number.isSafeInteger(object.size) || object.size < 0) return json({ error: "archive_status_unavailable" }, 503);
        r2ObjectCount++;
        r2BytesConservative += object.size + R2_OBJECT_METADATA_BUDGET_BYTES;
        if (r2ObjectCount > MAX_R2_OBJECTS_PER_STATUS || !Number.isSafeInteger(r2BytesConservative)) {
          return json({ error: "r2_inventory_budget_exceeded" }, 503);
        }
      }
      return json({ dataset: { expected_rows: dataset.expected_rows, verified_rows: dataset.verified_rows,
        state: dataset.state, verified_at: dataset.verified_at ?? null, mirrorBudgetDay: dataset.mirror_budget_day,
        mirrorRowsToday: dataset.mirror_rows_today, mirrorRowsDailyLimit: MAX_MIRROR_ROWS_PER_DAY },
      d1Bytes: ping.meta.size_after, databaseLimitBytes: 500_000_000,
        remainingDatabaseBytes: Math.max(0, 500_000_000 - ping.meta.size_after), r2ObjectCount,
        r2BytesConservative, r2BudgetBytes: R2_ACCOUNT_BUDGET_BYTES,
        r2RemainingBytes: Math.max(0, R2_ACCOUNT_BUDGET_BYTES - r2BytesConservative) });
    } catch {
      return json({ error: "archive_status_unavailable" }, 503);
    }
  }
  const parsed = parseRequest(url);
  if (parsed.error) return json({ error: parsed.error }, 400);
  const query = buildQuery(parsed.value);
  const started = Date.now();
  try {
    const dataset = await env.DB.prepare("SELECT expected_rows,verified_rows,state FROM archive_dataset_status WHERE dataset=?")
      .bind("symbol_daily_returns_v1").first();
    if (!dataset || dataset.state !== "verified" || dataset.expected_rows !== dataset.verified_rows) {
      return json({ error: "archive_dataset_not_verified" }, 503);
    }
    const result = await env.DB.prepare(query.sql).bind(...query.params).all();
    const rowsRead = Number(result.meta?.rows_read ?? 0);
    if (result.success === false || !Array.isArray(result.results) || rowsRead > MAX_ROWS_READ) {
      console.log(JSON.stringify({ event: "kairos_archive_read_rejected", code: rowsRead > MAX_ROWS_READ ? "rows_read_budget" : "invalid_result", rowsRead }));
      return json({ error: "archive_query_budget_exceeded" }, 503);
    }
    console.log(JSON.stringify({ event: "kairos_archive_read", rows: result.results.length, rowsRead,
      durationMs: Date.now() - started, market: parsed.value.market, mode: parsed.value.mode }));
    return json({ rows: result.results, rowsRead, offset: parsed.value.offset, limit: parsed.value.limit,
      hasMore: result.results.length === parsed.value.limit });
  } catch {
    console.error(JSON.stringify({ event: "kairos_archive_read_failed", durationMs: Date.now() - started }));
    return json({ error: "archive_read_failed" }, 503);
  }
}

export default { fetch: handleRequest };
