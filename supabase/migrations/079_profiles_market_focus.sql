-- profiles.market_focus was referenced by app code (India MarketSwitcher
-- gating, gatherSymbols region-ETF logic) for a long time but the column
-- never actually existed in the live schema — the switcher was silently
-- hidden this whole time. Discovered 2026-07-06 via information_schema.
alter table profiles add column if not exists market_focus text not null default 'US,India';
update profiles set market_focus = 'US,India' where market_focus is null or market_focus = 'US';
