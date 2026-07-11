-- Migration 158: Update kairos_call_agent base_url and stale-check job
-- to use canonical Vercel project URL (financeos-phi.vercel.app).
-- Previous URL (financeos-vaibhavtiwarigithubs-projects.vercel.app) was
-- auto-generated project alias; CLI deploys update only the phi URL.

CREATE OR REPLACE FUNCTION public.kairos_call_agent(
  endpoint text,
  body jsonb DEFAULT '{}'::jsonb,
  method text DEFAULT 'POST'::text,
  timeout_ms integer DEFAULT 70000
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'vault'
AS $function$
declare
  secret text;
  base_url text := 'https://financeos-phi.vercel.app';
begin
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'kairos_cron_secret';
  if secret is null then
    raise exception 'kairos_cron_secret not found in vault';
  end if;

  perform net.http_post(
    url := base_url || endpoint,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', secret),
    body := body,
    timeout_milliseconds := timeout_ms
  );
end;
$function$;

-- Fix stale-check job (job 40) which uses raw net.http_get with old URL
SELECT cron.unschedule('kairos-stale-check');
SELECT cron.schedule(
  'kairos-stale-check',
  '0 */4 * * *',
  $$
  select net.http_get(
    url := 'https://financeos-phi.vercel.app/api/alerts/stale-check',
    timeout_milliseconds := 30000
  )
  $$
);
