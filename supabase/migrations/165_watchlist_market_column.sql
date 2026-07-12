-- watchlist.market — the multi-market watchlist code (app/api/watchlist/route.ts
-- GET/POST + WatchlistPanel) has shipped reading and writing watchlist.market
-- for months, but NO migration ever created the column. Result on prod:
--   • GET selects `market` → PostgREST 500 → panel shows "0 tracked" while 241
--     real rows sit hidden.
--   • POST always sends market ("US"/"India") → insert 500 → every manual add
--     silently fails (the client swallows the error).
-- This adds the missing column. Values are Title-case to match the route code,
-- which filters `.eq("market","India")` / `.in("market",["US","Global","Crypto"])`
-- and writes "US"/"India". Default 'US' backfills all existing rows to the US
-- view — identical to the prior unfiltered behavior for every current user.
alter table public.watchlist add column if not exists market text not null default 'US';

-- Backfill India rows where inferable from the symbol suffix (.NS/.BO = NSE/BSE),
-- so a previously-added India ticker lands in the India-filtered view instead of US.
update public.watchlist set market = 'India'
where market = 'US' and symbol ~* '\.(NS|BO)$';
