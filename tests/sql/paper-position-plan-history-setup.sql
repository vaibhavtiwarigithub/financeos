-- DISPOSABLE LOCAL DATABASE ONLY. Never run these financial fixtures in production.
\set ON_ERROR_STOP on
create role anon;
create role authenticated;
create role service_role bypassrls;
create table public.paper_positions (id uuid primary key,market text,symbol text,position_role text,opened_at timestamptz,stop_loss numeric,price_target numeric,current_price numeric);
insert into public.paper_positions values ('00000000-0000-4000-8000-000000000001','us','TEST-NO-REAL-ASSET','alpha','2026-06-01',90,120,100);
