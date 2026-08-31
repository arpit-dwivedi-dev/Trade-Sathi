-- Watchlist: symbols a user wants to keep an eye on. Schema + client CRUD
-- only in this migration; the daily-briefing job/email/scheduler that
-- consumes this table is a separate follow-up.

create table public.watchlist_items (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  symbol      text not null,
  asset_class asset_class, -- nullable: the user may not know the category when adding a symbol
  created_at  timestamptz not null default now(),
  unique (profile_id, symbol)
);

create index watchlist_items_profile_id_created_at_idx
  on public.watchlist_items (profile_id, created_at desc);

alter table public.watchlist_items enable row level security;

-- Unlike analyses/usage_counters, this table carries no financial or
-- entitlement value — it's just "which symbols does this user care about" —
-- so it gets full client-side CRUD scoped to the owner, with no Trigger C
-- style column protection needed.
create policy watchlist_select_own on public.watchlist_items
  for select to authenticated
  using (profile_id = auth.uid());

create policy watchlist_insert_own on public.watchlist_items
  for insert to authenticated
  with check (profile_id = auth.uid());

create policy watchlist_delete_own on public.watchlist_items
  for delete to authenticated
  using (profile_id = auth.uid());

-- No UPDATE policy: a user removes and re-adds a symbol rather than editing
-- a watch entry in place.

-- Supabase's default auto-grant behavior for new tables has been changing
-- across projects during 2026 (new projects created after 2026-05-30 no
-- longer receive it by default; existing projects lose it on 2026-10-30).
-- Relying on whatever default happens to be active would make this table's
-- real access level project-vintage-dependent rather than an explicit
-- decision, so grants are set explicitly here: anon gets nothing,
-- authenticated gets exactly what RLS is meant to allow on their own rows,
-- and service_role keeps its implicit full access.
revoke all on public.watchlist_items from anon, authenticated;
grant select, insert, delete on public.watchlist_items to authenticated;
