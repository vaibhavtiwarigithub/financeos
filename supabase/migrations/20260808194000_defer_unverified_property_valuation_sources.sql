-- The source-capability audit found that the Maricopa sales-affidavit feed and
-- TCAD export path do not yet have a verified, permitted machine-use contract.
-- Preserve historical evidence but prevent scheduled/ad-hoc collection and new
-- scope configuration from treating either source as active.

update public.property_sources
set activation_state = 'contract_pending'
where source_key in ('maricopa-sales', 'tcad-appraisal');

update public.property_valuation_scopes
set active = false, updated_at = now()
where source_key in ('maricopa-sales', 'tcad-appraisal') and active = true;
