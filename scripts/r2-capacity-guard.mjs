// Fail-closed, account-wide R2 capacity preflight for the Kairos upload path.
// It budgets the documented maximum per-object metadata as well as payload.
// Decimal GB matches Cloudflare's R2 GB-month quota and the owner's 8 GB cap.
export const R2_HARD_CAP_BYTES = 8_000_000_000;
export const R2_UPLOAD_CEILING_BYTES = 7_500_000_000;
export const R2_WARN_BYTES = 6_000_000_000;
export const R2_MAX_OBJECT_METADATA_BYTES = 8192;

const API = "https://api.cloudflare.com/client/v4";

function assertNonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid R2 ${label}; refusing upload`);
}

async function requestJson(url, token, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`R2 capacity inventory failed (${response.status}); refusing upload`);
  let body;
  try { body = await response.json(); } catch { throw new Error("Invalid R2 inventory response; refusing upload"); }
  if (!body?.success || !Array.isArray(body?.errors) || body.errors.length || body.result == null) {
    throw new Error("R2 capacity inventory was incomplete; refusing upload");
  }
  return body;
}

export async function listAccountObjects({ accountId, token, fetchImpl = fetch }) {
  if (!/^[a-f0-9]{32}$/.test(accountId ?? "") || typeof token !== "string" || token.length < 20) {
    throw new Error("Cloudflare account ID and R2 read token are required; refusing upload");
  }
  const buckets = [];
  let bucketCursor;
  const seenBucketCursors = new Set();
  do {
    const query = new URLSearchParams({ per_page: "1000" });
    if (bucketCursor) query.set("cursor", bucketCursor);
    const body = await requestJson(`${API}/accounts/${accountId}/r2/buckets?${query}`, token, fetchImpl);
    const found = body.result?.buckets;
    if (!Array.isArray(found)) throw new Error("R2 bucket inventory is incomplete; refusing upload");
    buckets.push(...found);
    const info = body.result_info;
    if (!Number.isSafeInteger(info?.total_count) || info.total_count < buckets.length) {
      throw new Error("R2 bucket inventory count is incomplete; refusing upload");
    }
    bucketCursor = info.cursor || undefined;
    if (bucketCursor) {
      if (seenBucketCursors.has(bucketCursor)) throw new Error("R2 bucket inventory pagination is invalid; refusing upload");
      seenBucketCursors.add(bucketCursor);
    } else if (buckets.length !== info.total_count) {
      throw new Error("R2 bucket inventory pagination is incomplete; refusing upload");
    }
    if (seenBucketCursors.size > 100_000) throw new Error("R2 bucket inventory pagination is invalid; refusing upload");
  } while (bucketCursor);

  const objects = [];
  for (const bucket of buckets) {
    if (typeof bucket.name !== "string" || !bucket.name) throw new Error("R2 bucket inventory is invalid; refusing upload");
    let cursor;
    const seenCursors = new Set();
    do {
      const query = new URLSearchParams({ per_page: "1000" });
      if (cursor) query.set("cursor", cursor);
      const body = await requestJson(`${API}/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucket.name)}/objects?${query}`, token, fetchImpl);
      if (!Array.isArray(body.result)) throw new Error("R2 object inventory is incomplete; refusing upload");
      if (typeof body.result_info?.is_truncated !== "boolean") throw new Error("R2 object inventory pagination is incomplete; refusing upload");
      for (const object of body.result) {
        if (typeof object.key !== "string") throw new Error("R2 object inventory is invalid; refusing upload");
        assertNonNegativeSafeInteger(object.size, "object size");
        objects.push({ bucket: bucket.name, key: object.key, size: object.size });
      }
      if (body.result_info.is_truncated) {
        const next = body.result_info.cursor;
        if (typeof next !== "string" || !next || seenCursors.has(next)) throw new Error("R2 object inventory pagination is invalid; refusing upload");
        seenCursors.add(next);
        cursor = next;
      } else cursor = undefined;
      if (seenCursors.size > 1_000_000) throw new Error("R2 object inventory pagination is invalid; refusing upload");
    } while (cursor);
  }
  return objects;
}

export function estimateBudgetBytes(objects) {
  let total = 0;
  for (const object of objects) {
    assertNonNegativeSafeInteger(object.size, "object size");
    total += object.size + R2_MAX_OBJECT_METADATA_BYTES;
    if (!Number.isSafeInteger(total)) throw new Error("R2 inventory exceeds safe accounting range; refusing upload");
  }
  return total;
}

export function assertUploadWithinBudget(objects, incomingObjects) {
  if (!Array.isArray(incomingObjects) || incomingObjects.length === 0) throw new Error("R2 upload inventory is empty; refusing upload");
  const byKey = new Map(objects.map(object => [`${object.bucket}\0${object.key}`, object]));
  const replaced = new Set();
  let incomingBytes = 0;
  for (const object of incomingObjects) {
    if (typeof object.bucket !== "string" || !object.bucket || typeof object.key !== "string" || !object.key) {
      throw new Error("Invalid incoming R2 object key; refusing upload");
    }
    assertNonNegativeSafeInteger(object.size, "upload size");
    const identity = `${object.bucket}\0${object.key}`;
    if (replaced.has(identity)) throw new Error("Duplicate incoming R2 object key; refusing upload");
    replaced.add(identity);
    const existing = byKey.get(identity);
    if (existing) incomingBytes -= existing.size + R2_MAX_OBJECT_METADATA_BYTES;
    incomingBytes += object.size + R2_MAX_OBJECT_METADATA_BYTES;
  }
  const currentBytes = estimateBudgetBytes(objects);
  const projectedBytes = currentBytes + incomingBytes;
  if (!Number.isSafeInteger(projectedBytes) || projectedBytes > R2_UPLOAD_CEILING_BYTES) {
    throw new Error(`R2 upload refused: projected conservative usage ${projectedBytes} bytes exceeds the 7.5 GB upload ceiling`);
  }
  return { currentBytes, projectedBytes, hardCapBytes: R2_HARD_CAP_BYTES,
    warning: projectedBytes >= R2_WARN_BYTES };
}

export async function checkR2Capacity({ accountId, token = process.env.CLOUDFLARE_API_TOKEN,
  fetchImpl = fetch, incomingObjects }) {
  const objects = await listAccountObjects({ accountId, token, fetchImpl });
  return assertUploadWithinBudget(objects, incomingObjects);
}
