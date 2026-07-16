-- Watchlist market-casing normalization.
--
-- app/api/watchlist POST writes lowercase 'us'/'india' (the convention every agent
-- and market-scoped query uses), but the GET filtered on capitalized
-- 'US'/'India'/'Global'/'Crypto'. Result: the US view matched only the 7 rows that
-- inherited the column DEFAULT 'US' (written by theme-scout, which omits `market`),
-- and the India view matched nothing. 242 rows / 115 distinct symbols were hidden.
--
-- The original CHECK (market in ('US','India','Global','Crypto')) from
-- 001_initial_schema.sql:192 had been dropped from the live table, which is what
-- let three casings ('us', 'US', and the 'US' default) coexist.
--
-- Convention (locked): lowercase 'us' | 'india'. India is anything a .NS/.BO
-- symbol resolves to; everything else — including the legacy 'Global'/'Crypto'
-- values, which have ZERO rows in the live DB — is 'us', matching the read
-- intent that the US view shows every non-India row.

-- 1. Backfill to the lowercase convention.
UPDATE watchlist
SET market = CASE WHEN lower(market) = 'india' THEN 'india' ELSE 'us' END
WHERE market NOT IN ('us', 'india');

-- 2. Default was 'US' — a third casing that no reader matched. Make new rows that
--    omit `market` (theme-scout) land on the convention instead.
ALTER TABLE watchlist ALTER COLUMN market SET DEFAULT 'us';

-- 3. Restore the guardrail so casing can't regress.
ALTER TABLE watchlist
  ADD CONSTRAINT watchlist_market_lowercase_chk CHECK (market IN ('us', 'india'));
