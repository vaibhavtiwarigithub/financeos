-- Estimation method stamp on exposure rows. v1 (exact-date factor join) dropped ~30% of sessions and failed the
-- coverage gate for 156 of 157 symbols; v2 (last level within 4 days) replaces it. Append-only, so the method becomes
-- part of the key instead of overwriting v1 rows.
alter table public.india_macro_exposures add column if not exists method text not null default 'exact_date_v1';
alter table public.india_macro_exposures drop constraint if exists india_macro_exposures_symbol_window_end_key;
alter table public.india_macro_exposures add constraint india_macro_exposures_symbol_window_end_method_key unique (symbol, window_end, method);
