import { reportIssue, resolveIssue } from "@/lib/system-health";

export const SUPABASE_STORAGE_TARGET_BYTES = 400_000_000;
export const SUPABASE_STORAGE_WARN_BYTES = 350_000_000;
export const SUPABASE_STORAGE_CRITICAL_BYTES = 380_000_000;
export const SUPABASE_FREE_DATABASE_LIMIT_BYTES = 500_000_000;
export const CLOUDFLARE_D1_DATABASE_LIMIT_BYTES = 500_000_000;
export const CLOUDFLARE_D1_WARN_BYTES = 350_000_000;
export const CLOUDFLARE_D1_CRITICAL_BYTES = 450_000_000;
export const CLOUDFLARE_R2_BUDGET_BYTES = 8_000_000_000;
export const CLOUDFLARE_R2_WARN_BYTES = 6_000_000_000;
export const CLOUDFLARE_R2_CRITICAL_BYTES = 7_500_000_000;

type StorageReport = {
  database_bytes: number;
  measured_at: string;
  top_relations: Array<{ schema: string; name: string; bytes: number }>;
};

type RpcClient = {
  rpc: (name: string) => Promise<{ data: unknown; error: { message?: string } | null }>;
};

export async function measureSupabaseStorage(svc: RpcClient) {
  const { data, error } = await svc.rpc("get_database_storage_report");
  if (error) throw new Error(error.message || "Database size measurement failed");
  const report = data as StorageReport | null;
  if (!report || !Number.isSafeInteger(report.database_bytes) || report.database_bytes < 0
    || typeof report.measured_at !== "string" || !Array.isArray(report.top_relations)
    || report.top_relations.some((relation) => !relation || typeof relation.name !== "string"
      || typeof relation.schema !== "string" || !Number.isSafeInteger(relation.bytes) || relation.bytes < 0)) {
    throw new Error("Database size measurement returned an invalid report");
  }

  const bytes = report.database_bytes;
  const sizeMiB = (bytes / (1024 * 1024)).toFixed(1);
  const largest = report.top_relations.slice(0, 5)
    .map((relation) => `${relation.schema}.${relation.name}: ${(relation.bytes / (1024 * 1024)).toFixed(1)} MiB`)
    .join(", ");

  if (bytes >= SUPABASE_STORAGE_WARN_BYTES) {
    const severity = bytes >= SUPABASE_STORAGE_CRITICAL_BYTES ? "critical" : "warn";
    const title = bytes >= SUPABASE_FREE_DATABASE_LIMIT_BYTES
      ? "Supabase database exceeds the Free plan size limit"
      : bytes >= SUPABASE_STORAGE_TARGET_BYTES
        ? "Supabase database exceeds the Kairos 400 MB target"
        : "Supabase database is approaching its Free plan limit";
    await reportIssue({
      issueKey: "supabase-database-storage",
      severity,
      category: "data",
      title,
      detail: `Measured ${(bytes / 1_000_000).toFixed(1)} MB (${sizeMiB} MiB); Kairos target is 400 MB and the Free plan limit is 500 MB. Largest public relations: ${largest || "unavailable"}.`,
    });
  } else {
    await resolveIssue("supabase-database-storage");
  }

  return {
    databaseBytes: bytes,
    measuredAt: report.measured_at,
    targetBytes: SUPABASE_STORAGE_TARGET_BYTES,
    warningBytes: SUPABASE_STORAGE_WARN_BYTES,
    criticalBytes: SUPABASE_STORAGE_CRITICAL_BYTES,
    freeLimitBytes: SUPABASE_FREE_DATABASE_LIMIT_BYTES,
    largestRelations: report.top_relations.slice(0, 10),
    status: bytes >= SUPABASE_FREE_DATABASE_LIMIT_BYTES ? "over_free_limit"
      : bytes >= SUPABASE_STORAGE_TARGET_BYTES ? "over_target"
        : bytes >= SUPABASE_STORAGE_WARN_BYTES ? "warning" : "healthy",
  } as const;
}

type D1ArchiveReport = {
  dataset: { expected_rows: number; verified_rows: number; state: "loading" | "verified" | "degraded"; verified_at?: string | null;
    mirrorBudgetDay: string | null; mirrorRowsToday: number; mirrorRowsDailyLimit: number } | null;
  d1Bytes: number;
  databaseLimitBytes: number;
  remainingDatabaseBytes: number;
  r2ObjectCount: number;
  r2BytesConservative: number;
  r2BudgetBytes: number;
  r2RemainingBytes: number;
};

export async function measureCloudflareD1Storage(sourceRows: number, fetchImpl: typeof fetch = fetch) {
  if (!Number.isSafeInteger(sourceRows) || sourceRows < 0) throw new Error("Supabase daily-return source count is invalid");
  const endpoint = process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_URL;
  const token = process.env.KAIROS_SYMBOL_RETURNS_ARCHIVE_TOKEN;
  if (!endpoint || !token || token.length < 32) throw new Error("Cloudflare D1 archive monitor is not configured");
  let response: Response;
  try {
    response = await fetchImpl(new URL("/v1/status", endpoint), {
      method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store", signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("Cloudflare D1 archive status is unavailable");
  }
  if (!response.ok) throw new Error(`Cloudflare D1 archive status failed (${response.status})`);
  const report = await response.json() as D1ArchiveReport;
  if (!report || !Number.isSafeInteger(report.d1Bytes) || report.d1Bytes < 0
    || report.databaseLimitBytes !== CLOUDFLARE_D1_DATABASE_LIMIT_BYTES
    || report.remainingDatabaseBytes !== Math.max(0, report.databaseLimitBytes - report.d1Bytes)
    || !Number.isSafeInteger(report.r2ObjectCount) || report.r2ObjectCount < 0
    || !Number.isSafeInteger(report.r2BytesConservative) || report.r2BytesConservative < 0
    || report.r2BudgetBytes !== CLOUDFLARE_R2_BUDGET_BYTES
    || report.r2RemainingBytes !== Math.max(0, report.r2BudgetBytes - report.r2BytesConservative)
    || !report.dataset || !Number.isSafeInteger(report.dataset.expected_rows)
    || !Number.isSafeInteger(report.dataset.verified_rows)
    || !["loading", "verified", "degraded"].includes(report.dataset.state)
    || (report.dataset.mirrorBudgetDay !== null && !/^\d{4}-\d{2}-\d{2}$/.test(report.dataset.mirrorBudgetDay))
    || !Number.isSafeInteger(report.dataset.mirrorRowsToday) || report.dataset.mirrorRowsToday < 0
    || report.dataset.mirrorRowsDailyLimit !== 15_000 || report.dataset.mirrorRowsToday > report.dataset.mirrorRowsDailyLimit) {
    throw new Error("Cloudflare D1 archive status returned an invalid report");
  }
  const sourceRowsMatch = report.dataset.expected_rows === sourceRows && report.dataset.verified_rows === sourceRows;
  const rowsComplete = report.dataset.state === "verified" && report.dataset.verified_rows === report.dataset.expected_rows && sourceRowsMatch;
  const mirrorBudgetNearLimit = report.dataset.mirrorRowsToday >= Math.floor(report.dataset.mirrorRowsDailyLimit * 0.8);
  const r2OverWarn = report.r2BytesConservative >= CLOUDFLARE_R2_WARN_BYTES;
  const critical = report.d1Bytes >= CLOUDFLARE_D1_CRITICAL_BYTES || report.r2BytesConservative >= CLOUDFLARE_R2_CRITICAL_BYTES;
  const title = report.r2BytesConservative >= CLOUDFLARE_R2_BUDGET_BYTES
    ? "Kairos Cloudflare R2 archive reached its 8 GB budget"
    : report.r2BytesConservative >= CLOUDFLARE_R2_CRITICAL_BYTES
      ? "Kairos Cloudflare R2 archive reached its 7.5 GB upload stop"
      : report.d1Bytes >= CLOUDFLARE_D1_DATABASE_LIMIT_BYTES
        ? "Cloudflare D1 archive reached its Free database limit"
    : report.d1Bytes >= CLOUDFLARE_D1_CRITICAL_BYTES
      ? "Cloudflare D1 archive is near its Free database limit"
      : r2OverWarn ? "Kairos Cloudflare R2 archive is approaching its 8 GB budget"
        : "Cloudflare D1 archive is approaching its Free database limit";
  if (report.d1Bytes >= CLOUDFLARE_D1_WARN_BYTES || r2OverWarn || !rowsComplete || mirrorBudgetNearLimit) {
    await reportIssue({
      issueKey: "cloudflare-d1-archive-storage",
      severity: critical ? "critical" : "warn",
      category: "data",
      title: !rowsComplete ? "Cloudflare D1 archive is not fully verified" : mirrorBudgetNearLimit ? "Cloudflare D1 daily mirror-write budget is near its cap" : title,
      detail: `D1 database ${report.d1Bytes} bytes of ${report.databaseLimitBytes}; daily-return parity ${report.dataset.verified_rows} verified / ${report.dataset.expected_rows} expected / ${sourceRows} live Supabase rows; daily mirror intake ${report.dataset.mirrorRowsToday}/${report.dataset.mirrorRowsDailyLimit} source rows for UTC day ${report.dataset.mirrorBudgetDay ?? "not started"}; bound Kairos R2 bucket ${report.r2BytesConservative} conservative bytes of ${report.r2BudgetBytes} across ${report.r2ObjectCount} objects; dataset state=${report.dataset.state}.`,
    });
  } else {
    await resolveIssue("cloudflare-d1-archive-storage");
  }
  return {
    d1Bytes: report.d1Bytes,
    databaseLimitBytes: report.databaseLimitBytes,
    remainingDatabaseBytes: report.remainingDatabaseBytes,
    r2ObjectCount: report.r2ObjectCount,
    r2BytesConservative: report.r2BytesConservative,
    r2BudgetBytes: report.r2BudgetBytes,
    r2RemainingBytes: report.r2RemainingBytes,
    datasetState: report.dataset.state,
    expectedRows: report.dataset.expected_rows,
    verifiedRows: report.dataset.verified_rows,
    sourceRows,
    sourceRowsMatch,
    mirrorBudget: { utcDay: report.dataset.mirrorBudgetDay, rowsAcceptedToday: report.dataset.mirrorRowsToday,
      rowsDailyLimit: report.dataset.mirrorRowsDailyLimit, remainingRowsToday: Math.max(0, report.dataset.mirrorRowsDailyLimit - report.dataset.mirrorRowsToday) },
    rowsComplete,
    status: !rowsComplete ? "loading_or_unverified" as const
      : report.d1Bytes >= CLOUDFLARE_D1_DATABASE_LIMIT_BYTES || report.r2BytesConservative >= CLOUDFLARE_R2_BUDGET_BYTES ? "over_limit" as const
        : critical ? "critical_capacity" as const
          : r2OverWarn || report.d1Bytes >= CLOUDFLARE_D1_WARN_BYTES || mirrorBudgetNearLimit ? "warning" as const : "healthy" as const,
  };
}
