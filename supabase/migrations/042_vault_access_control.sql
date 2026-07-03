-- Security: lock vault.decrypted_secrets to service role only.
-- anon and authenticated roles must never be able to read plaintext secrets.
-- Attack vector closed: a logged-in user hitting a misconfigured RLS policy
-- cannot pivot to read OAuth tokens from vault.decrypted_secrets.

-- Revoke read access from public roles on the vault schema
revoke all on schema vault from anon, authenticated;
revoke all on all tables in schema vault from anon, authenticated;

-- Explicitly revoke the decrypted_secrets view (most sensitive)
-- The view returns plaintext — only service_role (server-side only) should see it.
revoke select on vault.decrypted_secrets from anon, authenticated;

-- api_key_vault custom table: same treatment — never readable by browser sessions
revoke select on table api_key_vault from anon, authenticated;

-- Confirm service_role still has access (default grant, stated explicitly for clarity)
grant all on schema vault to service_role;
grant all on all tables in schema vault to service_role;
grant select on table api_key_vault to service_role;
