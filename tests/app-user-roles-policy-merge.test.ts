import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20261028145820_merge_equivalent_app_user_roles_read_policies.sql",
  "utf8",
);

describe("app_user_roles SELECT policy consolidation", () => {
  it("keeps the exact owner-email OR self-user visibility predicates", () => {
    expect(migration).toContain("user_id = (SELECT auth.uid())");
    expect(migration).toContain(
      "((SELECT auth.jwt()) ->> 'email'::text) = 'vterminater@gmail.com'::text",
    );
    expect(migration).toContain("CREATE POLICY app_user_roles_owner_or_self_read");
  });

  it("does not add write access or grant privileges", () => {
    expect(migration).not.toMatch(/^\s*(GRANT|REVOKE)\b|FOR\s+(INSERT|UPDATE|DELETE|ALL)|WITH CHECK/im);
  });
});
