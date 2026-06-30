-- Disable RLS on macro tables (internal agent tables, no user data)
-- Service role client should bypass RLS anyway, but disable explicitly
-- to avoid any project-level RLS default causing "Unauthorized" errors.
ALTER TABLE macro_regime DISABLE ROW LEVEL SECURITY;
ALTER TABLE macro_signals DISABLE ROW LEVEL SECURITY;
