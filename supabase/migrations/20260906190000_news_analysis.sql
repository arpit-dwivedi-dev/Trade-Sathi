-- News-analysis feature: ingested/de-duplicated stories, per-symbol sentiment
-- snapshots, price-reaction analytics, and per-user alert settings. See the
-- news-analysis MVP plan for the full design.
--
-- news_stories / news_sentiment_snapshots / news_price_reactions are market
-- data, not user data (same posture as public.instruments): world-readable to
-- any authenticated caller, writes only via the service-role key from
-- services/news.service.ts. news_alert_settings is user data, RLS-scoped to
-- its owner exactly like watchlist_items.

create table public.news_stories (
  id                     uuid primary key default gen_random_uuid(),
  primary_symbol         text not null,
  linked_symbols         text[] not null default '{}',
  title                  text not null,
  snippet                text not null default '',
  category               text not null check (category in ('markets', 'economy', 'corporate', 'global', 'industry')),
  source_tier            text not null check (source_tier in ('official', 'verified', 'rumor_social')),
  -- Array of {name, url, tier, publishedAt}; length > 1 = cross-verified.
  sources                jsonb not null default '[]',
  published_at           timestamptz not null,
  sentiment              text check (sentiment in ('bullish', 'bearish', 'neutral')),
  sentiment_confidence   numeric,
  impact_scope           text check (impact_scope in ('company', 'sector', 'macro')),
  time_horizon           text check (time_horizon in ('intraday', 'short_term', 'thesis_changing')),
  key_facts              jsonb not null default '[]',
  -- Normalized-title fingerprint the dedup pass upserts against; see lib/news/dedupe.ts.
  dedup_key              text not null,
  created_at             timestamptz not null default now(),
  unique (primary_symbol, dedup_key)
);

create index news_stories_symbol_published_idx
  on public.news_stories (primary_symbol, published_at desc);

-- The ingest pipeline reads unclassified rows (sentiment is null) per symbol
-- to batch through the AI classifier — see news.service.ts.
create index news_stories_unclassified_idx
  on public.news_stories (primary_symbol)
  where sentiment is null;

alter table public.news_stories enable row level security;

create policy news_stories_select_all on public.news_stories
  for select to authenticated
  using (true);

revoke all on public.news_stories from anon, authenticated;
grant select on public.news_stories to authenticated;

create table public.news_sentiment_snapshots (
  id                      uuid primary key default gen_random_uuid(),
  symbol                  text not null,
  computed_at             timestamptz not null default now(),
  net_sentiment           numeric not null,
  net_sentiment_label     text not null check (net_sentiment_label in ('bullish', 'bearish', 'neutral')),
  key_drivers             jsonb not null default '[]',
  story_count_1h          int not null default 0,
  story_count_24h         int not null default 0,
  historical_avg_per_hour numeric not null default 0,
  created_at              timestamptz not null default now()
);

create index news_sentiment_snapshots_symbol_computed_idx
  on public.news_sentiment_snapshots (symbol, computed_at desc);

alter table public.news_sentiment_snapshots enable row level security;

create policy news_sentiment_snapshots_select_all on public.news_sentiment_snapshots
  for select to authenticated
  using (true);

revoke all on public.news_sentiment_snapshots from anon, authenticated;
grant select on public.news_sentiment_snapshots to authenticated;

create table public.news_price_reactions (
  id                   uuid primary key default gen_random_uuid(),
  story_id             uuid not null references public.news_stories(id) on delete cascade,
  symbol               text not null,
  pre_price            numeric,
  post_price           numeric,
  pct_move             numeric,
  expected_volatility  numeric,
  abnormal_return      numeric,
  already_priced_in    boolean,
  classification       text check (classification in ('market_moving', 'minor_noise')),
  computed_at          timestamptz not null default now(),
  unique (story_id)
);

create index news_price_reactions_symbol_idx
  on public.news_price_reactions (symbol, computed_at desc);

alter table public.news_price_reactions enable row level security;

create policy news_price_reactions_select_all on public.news_price_reactions
  for select to authenticated
  using (true);

revoke all on public.news_price_reactions from anon, authenticated;
grant select on public.news_price_reactions to authenticated;

create table public.news_alert_settings (
  id                       uuid primary key default gen_random_uuid(),
  profile_id               uuid not null references public.profiles(id) on delete cascade,
  symbol                   text not null,
  impact_threshold         text not null default 'company' check (impact_threshold in ('company', 'sector', 'macro')),
  sentiment_change_alerts  boolean not null default true,
  cooldown_minutes         int not null default 60 check (cooldown_minutes > 0),
  last_alerted_at          timestamptz,
  created_at               timestamptz not null default now(),
  unique (profile_id, symbol)
);

create index news_alert_settings_profile_id_idx
  on public.news_alert_settings (profile_id);

alter table public.news_alert_settings enable row level security;

-- Same posture as watchlist_items: no financial/entitlement value, full
-- client-side CRUD scoped to the owner. The one exception is UPDATE, which
-- goes through the API (PUT /api/news/:symbol/alert-settings) so the backend
-- ingest job can also update last_alerted_at with the service-role key —
-- still exposed here too since a settings edit from the client is itself an
-- update, not a delete+insert like watchlist.
create policy news_alert_settings_select_own on public.news_alert_settings
  for select to authenticated
  using (profile_id = auth.uid());

create policy news_alert_settings_insert_own on public.news_alert_settings
  for insert to authenticated
  with check (profile_id = auth.uid());

create policy news_alert_settings_update_own on public.news_alert_settings
  for update to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

create policy news_alert_settings_delete_own on public.news_alert_settings
  for delete to authenticated
  using (profile_id = auth.uid());

revoke all on public.news_alert_settings from anon, authenticated;
grant select, insert, update, delete on public.news_alert_settings to authenticated;
