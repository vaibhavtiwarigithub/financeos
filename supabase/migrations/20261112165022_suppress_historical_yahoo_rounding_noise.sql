-- Bound future price-cache restatement growth without editing any retained records.
CREATE OR REPLACE FUNCTION public.price_cache_detect_restatement()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
begin

  -- Historical Yahoo adjusted closes can oscillate at sub-ppm precision.
  -- Keep the stored close on a close-only rounding change. Compare against the
  -- retained value so successive tiny changes cannot accumulate unnoticed.
  if old.date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     and old.date < to_char((statement_timestamp() at time zone 'UTC')::date - 60, 'YYYY-MM-DD')
     and new.symbol is not distinct from old.symbol
     and new.date is not distinct from old.date
     and old.provider = 'yahoo' and new.provider = 'yahoo'
     and old.price_basis = 'adjusted' and new.price_basis = 'adjusted'
     and new.provenance_version is not distinct from old.provenance_version
     and new.open is not distinct from old.open
     and new.high is not distinct from old.high
     and new.low is not distinct from old.low
     and new.volume is not distinct from old.volume
     and old.close > 0 and new.close > 0
     and new.close is distinct from old.close
     and abs(new.close - old.close) < old.close * 0.000001 then
    new.close := old.close;
    new.first_seen_at := old.first_seen_at;
  end if;
  if new.open is distinct from old.open
     or new.high is distinct from old.high
     or new.low is distinct from old.low
     or new.close is distinct from old.close
     or new.volume is distinct from old.volume
     or new.provider is distinct from old.provider
     or new.price_basis is distinct from old.price_basis then
    insert into public.price_cache_restatements (
      symbol, date,
      old_open, old_high, old_low, old_close, old_volume,
      new_open, new_high, new_low, new_close, new_volume,
      old_provider, new_provider, old_price_basis, new_price_basis,
      close_delta_pct)
    values (
      old.symbol, old.date,
      old.open, old.high, old.low, old.close, old.volume,
      new.open, new.high, new.low, new.close, new.volume,
      old.provider, new.provider, old.price_basis, new.price_basis,
      case when old.close is not null and old.close <> 0
           then ((new.close - old.close) / old.close) * 100 else null end);
    -- Preserve the original discovery time across restatements.
    new.first_seen_at := old.first_seen_at;
  end if;
  return new;
end $$;
