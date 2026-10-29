-- Restore the deployed app_settings baseline (migration
-- 20260629191857 / 014_app_settings_vault_pin), which stores owner settings
-- including the legacy vault-PIN value. It is intentionally not seeded here.
-- Migration 102 revokes client grants; service-role application paths bypass RLS.

CREATE TABLE IF NOT EXISTS public.app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
