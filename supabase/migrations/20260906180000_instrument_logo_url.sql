-- Caches the resolved logo URL per instrument so a symbol is only ever
-- looked up once against the external logo sources (a keyless NSE/BSE logo
-- directory, then logo.dev) — every search after that serves this column
-- straight from the already-loaded in-memory catalogue.
alter table instruments
  add column if not exists logo_url text,
  add column if not exists logo_checked_at timestamptz;
