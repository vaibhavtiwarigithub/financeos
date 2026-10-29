-- Restore production's original 008 price-cache baseline and the legacy
-- risk-analytics cache table required by migration 053. These definitions are
-- derived from the current deployed schema; later tracked migrations add the
-- price provenance fields and owner/service RLS policies.

CREATE TABLE IF NOT EXISTS public.price_cache (
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,
  open NUMERIC,
  high NUMERIC,
  low NUMERIC,
  close NUMERIC NOT NULL,
  volume BIGINT,
  cached_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT price_cache_pkey PRIMARY KEY (symbol, date)
);

CREATE INDEX IF NOT EXISTS idx_price_cache_symbol_date
  ON public.price_cache (symbol, date DESC);

ALTER TABLE public.price_cache ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.risk_analytics_cache (
  id BIGSERIAL PRIMARY KEY,
  account_source TEXT NOT NULL,
  computed_at TIMESTAMPTZ DEFAULT now(),
  holdings JSONB,
  metrics JSONB,
  warnings JSONB
);

ALTER TABLE public.risk_analytics_cache ENABLE ROW LEVEL SECURITY;
