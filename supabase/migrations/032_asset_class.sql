-- Add asset_class to agent_signals for multi-asset screener support
alter table agent_signals add column if not exists asset_class text default 'us_equity';

-- Index for filtering by asset class
create index if not exists agent_signals_asset_class_idx on agent_signals(asset_class);

-- Seed: label existing ETF signals
update agent_signals
set asset_class = 'etf'
where symbol in ('SPY','QQQ','IWM','DIA','XLF','XLE','XLK','XLU','XLV','XLRE','XLI','XLB','XLP','XLY','GLD','SLV','TLT','HYG','LQD','VIX','IAU','GDX','GDXJ');

-- Seed: label metals
update agent_signals
set asset_class = 'metal'
where symbol in ('GLD','SLV','GDX','GDXJ','IAU','GOLD','NEM','AEM','WPM');
