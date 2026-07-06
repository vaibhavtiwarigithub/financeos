-- Backfill: watchlist columns Theme Scout (app/api/agents/theme-scout/route.ts)
-- and the manual Watchlist API (app/api/watchlist/route.ts) already read/write
-- live, applied via Supabase MCP during a prior session but never committed as
-- a migration file (Codex adversarial review, 2026-07-06). Idempotent — safe to
-- run against the already-correct live schema.
-- Also relaxes user_id to nullable to match the live schema: auto-added rows
-- (Theme Scout, briefing) are owned by the app's single profile when available,
-- but must not hard-fail if no profile row exists yet.

alter table public.watchlist alter column user_id drop not null;

alter table public.watchlist add column if not exists source text not null default 'manual';
alter table public.watchlist add column if not exists theme text;
alter table public.watchlist add column if not exists reason text;
alter table public.watchlist add column if not exists auto_added boolean not null default false;
alter table public.watchlist add column if not exists expires_at timestamptz;
alter table public.watchlist add column if not exists updated_at timestamptz default now();
alter table public.watchlist add column if not exists research_enabled boolean not null default true;
alter table public.watchlist add column if not exists alert_on_signal boolean not null default true;
alter table public.watchlist add column if not exists alert_on_earnings boolean not null default false;
alter table public.watchlist add column if not exists company_name text;
alter table public.watchlist add column if not exists alert_price numeric;
