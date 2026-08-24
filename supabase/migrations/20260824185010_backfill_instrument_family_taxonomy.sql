-- Backfill only deterministic curated classifications so diagnostics can expose
-- historical cap saturation immediately. No historical feature value is
-- reconstructed: features is deliberately empty and feature_version says so.

insert into public.instrument_family_observations (
  observation_id, created_at, market, symbol, instrument_family, exposure_id,
  taxonomy_version, feature_version, benchmark_symbol, features, lifecycle
)
select
  d.id, d.ts, d.market, upper(d.symbol),
  case
    when upper(d.symbol) in ('GLD','IAU') then 'gold_bullion_fund'
    when upper(d.symbol) = 'SLV' then 'silver_bullion_fund'
    when upper(d.symbol) in ('GDX','GDXJ') then 'gold_miners_fund'
    when upper(d.symbol) in ('KGC','NEM','AEM','GOLD','AU','AGI','HL','PAAS') then 'metal_producer_equity'
    when upper(d.symbol) in ('FNV','WPM','RGLD') then 'royalty_streaming_equity'
    else 'india_etf'
  end,
  case
    when upper(d.symbol) in ('GLD','IAU') then 'gold_spot'
    when upper(d.symbol) = 'SLV' then 'silver_spot'
    when upper(d.symbol) in ('GDX','GDXJ','KGC','NEM','AEM','GOLD','AU','AGI','HL','PAAS') then 'gold_miners'
    when upper(d.symbol) in ('FNV','WPM','RGLD') then 'gold_royalty_streaming'
    when upper(d.symbol) = 'GOLDBEES.NS' then 'gold_spot_inr'
    when upper(d.symbol) = 'SILVERBEES.NS' then 'silver_spot_inr'
    when upper(d.symbol) = 'LIQUIDBEES.NS' then 'india_cash'
    when upper(d.symbol) = 'NIFTYBEES.NS' then 'india_index:nifty50'
    when upper(d.symbol) = 'JUNIORBEES.NS' then 'india_index:nifty_next50'
    when upper(d.symbol) = 'BANKBEES.NS' then 'india_sector:banks'
    else 'india_sector:technology'
  end,
  'instrument-taxonomy.v1', 'taxonomy-backfill.v1',
  case
    when upper(d.symbol) in ('GLD','IAU') then 'GLD'
    when upper(d.symbol) = 'SLV' then 'SLV'
    when upper(d.symbol) in ('GDX','GDXJ','KGC','NEM','AEM','GOLD','AU','AGI','HL','PAAS','FNV','WPM','RGLD') then 'GDX'
    when upper(d.symbol) = 'NIFTYBEES.NS' then '^NSEI'
    when upper(d.symbol) = 'BANKBEES.NS' then '^NSEBANK'
    when upper(d.symbol) = 'ITBEES.NS' then '^CNXIT'
    else null
  end,
  '{}'::jsonb, 'measure_only'
from public.decision_observations d
where upper(d.symbol) in (
  'GLD','IAU','SLV','GDX','GDXJ','KGC','NEM','AEM','GOLD','AU','AGI','HL','PAAS','FNV','WPM','RGLD',
  'GOLDBEES.NS','SILVERBEES.NS','LIQUIDBEES.NS','NIFTYBEES.NS','JUNIORBEES.NS','BANKBEES.NS','ITBEES.NS'
)
on conflict (observation_id) do nothing;
