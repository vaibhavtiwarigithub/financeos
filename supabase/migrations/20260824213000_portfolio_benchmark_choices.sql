-- Display-only comparison benchmarks for the Portfolio return chart.
--
-- `is_primary` deliberately remains false. Choosing one in the UI persists an
-- app_settings display preference; it does not alter learning/promotion truth.
-- Inserts are identity-idempotent because the original table has no
-- (market,provider_symbol) unique constraint.

insert into public.benchmarks
  (market, label, kind, symbol, provider_symbol, currency, price_provider, is_primary, enabled)
select v.market, v.label, 'single', v.symbol, v.provider_symbol, v.currency,
       v.price_provider, false, true
from (values
  ('us',    'QQQ',                         'QQQ',            'QQQ',            'USD', 'massive_daily'),
  ('us',    'XLK',                         'XLK',            'XLK',            'USD', 'massive_daily'),
  ('us',    'XLF',                         'XLF',            'XLF',            'USD', 'massive_daily'),
  ('india', 'NIFTY IT (ITBEES)',           'ITBEES.NS',      'ITBEES.NS',      'INR', 'yahoo_daily'),
  ('india', 'NIFTY Bank (BANKBEES)',       'BANKBEES.NS',    'BANKBEES.NS',    'INR', 'yahoo_daily'),
  ('india', 'NIFTY Next 50 (JUNIORBEES)',  'JUNIORBEES.NS',  'JUNIORBEES.NS',  'INR', 'yahoo_daily')
) as v(market, label, symbol, provider_symbol, currency, price_provider)
where not exists (
  select 1 from public.benchmarks b
  where b.market = v.market and b.provider_symbol = v.provider_symbol
);
