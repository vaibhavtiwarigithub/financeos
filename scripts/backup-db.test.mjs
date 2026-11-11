import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const script = path.resolve("scripts/backup-db.ps1");

function runWith(url) {
  return spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
    env: { ...process.env, SUPABASE_DB_URL: url,
      PSModulePath: path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/Modules") },
    encoding: "utf8", timeout: 15000,
    windowsHide: true,
  });
}

test("backup rejects an unfinished connection before contacting Postgres", () => {
  const result = runWith("postgresql://postgres:[YOUR-PASSWORD]@[HOST]:5432/postgres");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /still a template/);
});

test("backup refuses another Supabase project without exposing the supplied password", () => {
  const password = "synthetic_password_do_not_echo_7391";
  const result = runWith(`postgresql://postgres.other:${password}@aws-0-us-east-2.pooler.supabase.com:5432/postgres`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not a valid connection\s+to the FinanceOS project/);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(password));
});

test("backup command keeps the connection URI off pg_dump's argument list", () => {
  const source = fs.readFileSync(script, "utf8");
  const dumpCall = source.split("\n").find(line => line.includes("& $PgDump "));
  assert.ok(dumpCall);
  assert.ok(!dumpCall.includes("$DbUrl"));
  assert.match(source, /\$env:PGPASSWORD = \$DbPassword/);
  assert.match(source, /\$env:SUPABASE_DB_URL = \$null/);
  assert.match(source, /-h \$DbUri\.Host -p \$DbUri\.Port -U \$DbUser/);
});
