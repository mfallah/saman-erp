-- SMS admin UI: human-readable Persian name for Limo templates.
-- Additive and nullable, so existing rows and the runtime DML role keep working.
ALTER TABLE erp."sms_templates" ADD COLUMN IF NOT EXISTS "name_fa" varchar(120);
