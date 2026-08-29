-- ChartAnalyzer — billing subscriptions and the webhook idempotency ledger.
--
-- Schema only. No application code reads or writes these tables yet; the
-- webhook handler that will is not written.

-- ---------------------------------------------------------------------------
-- 1. ENUMS
-- ---------------------------------------------------------------------------

-- Only one value today. Reserved as an enum rather than plain text because a
-- future mobile app (Ionic, planned later) will need Apple/Google in-app
-- purchase as a second provider. ALTER TYPE ... ADD VALUE is cheap; migrating a
-- text column to an enum later is not, so the column shape is reserved now.
create type billing_provider as enum ('razorpay');

-- Mirrors Razorpay's own subscription status vocabulary verbatim. This is
-- deliberate: a mapping layer between our own state names and the payment
-- provider's is where users reliably end up paid-but-locked-out or
-- unpaid-but-still-entitled. Do not invent a different set of values.
--
-- 'paused' is included even though Razorpay's general reference tables for
-- Create/Update/Resume/Fetch omit it — the Pause Subscription endpoint's own
-- documented example response shows a real subscription entity with
-- status: "paused". It is a genuine value the API returns, just inconsistently
-- documented across Razorpay's own pages.
create type subscription_status as enum (
  'created',
  'authenticated',
  'active',
  'pending',
  'halted',
  'cancelled',
  'completed',
  'expired',
  'paused'
);

create type webhook_result as enum ('applied', 'duplicate', 'error');

-- ---------------------------------------------------------------------------
-- 2. TABLE: subscriptions
-- ---------------------------------------------------------------------------

-- Tracks the lifecycle of a user's Razorpay subscription object, from creation
-- through cancellation/expiry.
--
-- This is a history/audit log of subscription objects, not a single
-- current-state row: a profile may accumulate multiple rows over time as
-- subscriptions are created, cancelled, and re-subscribed. profiles.plan_id
-- remains the source of truth for what a user is currently entitled to, updated
-- by whatever future webhook handler processes these events.
create table public.subscriptions (
  id                       uuid primary key default gen_random_uuid(),
  profile_id               uuid not null references public.profiles(id) on delete cascade,
  plan_id                  uuid not null references public.plans(id) on delete restrict,
  provider                 billing_provider not null default 'razorpay',
  -- Razorpay's sub_xxx — the identifier webhooks arrive keyed on.
  provider_subscription_id text not null unique,
  -- Razorpay's cust_xxx. Nullable until first checkout.
  provider_customer_id     text,
  status                   subscription_status not null,
  current_period_start     timestamptz,
  current_period_end       timestamptz,
  -- The subscription entity's next-scheduled-debit field, present in Razorpay's
  -- create/fetch responses and webhook payloads alike — not a webhook-only
  -- field. Reserved now even though no reminder job consumes it yet: storing it
  -- costs nothing, and a future job needs history it cannot reconstruct
  -- otherwise.
  charge_at                timestamptz,
  cancel_at_cycle_end      boolean not null default false,
  -- Paise. Money is always stored as an integer minor unit, never a float.
  amount_minor             int not null,
  currency                 text not null default 'INR',
  created_at               timestamptz not null default now(),
  -- Set explicitly by whatever code updates the row. No auto-update trigger,
  -- matching how usage_counters already handles this.
  updated_at               timestamptz not null default now()
);

-- "This profile's subscription history, most recent first."
create index subscriptions_profile_id_created_at_idx
  on public.subscriptions (profile_id, created_at desc);

alter table public.subscriptions enable row level security;

-- Exactly one client-facing policy, and this is intentional, not an oversight.
-- There are deliberately NO INSERT, UPDATE or DELETE policies for clients: rows
-- here are created and updated only by a future backend process using the
-- service role, in response to Razorpay webhooks — never directly by a client
-- action. A client able to write this table could grant itself a paid plan.
create policy subscriptions_select_own on public.subscriptions
  for select
  using (profile_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 3. TABLE: webhook_events
-- ---------------------------------------------------------------------------

-- Idempotency ledger for incoming payment-provider webhooks.
--
-- This table enables a future handler to detect and skip a retried delivery.
-- The unique constraint alone does NOT make retries a no-op automatically — it
-- only makes a duplicate INSERT fail. The future webhook handler must insert
-- this row FIRST, before doing any other processing, and treat a
-- unique-violation error on that insert as "already handled, acknowledge and
-- stop". The constraint is the mechanism that handler logic relies on, not a
-- substitute for writing that logic correctly.
create table public.webhook_events (
  id            uuid primary key default gen_random_uuid(),
  provider      billing_provider not null default 'razorpay',
  -- Razorpay's x-razorpay-event-id header value, which Razorpay documents as
  -- the identifier for duplicate-webhook-delivery detection.
  event_id      text not null,
  event_type    text not null,
  -- Optional audit trail, not used for logic.
  payload_hash  text,
  result        webhook_result not null default 'applied',
  error         text,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,

  -- Scoped to (provider, event_id) rather than event_id alone. event_id is
  -- Razorpay-specific today, but this keeps the uniqueness correctly
  -- provider-scoped from day one, consistent with billing_provider already
  -- being reserved for a future second provider (Apple/Google IAP).
  constraint webhook_events_provider_event_id_key unique (provider, event_id)
);

-- (provider, event_id) is already covered by the unique constraint above; this
-- index is for time-ordered lookups during debugging.
create index webhook_events_received_at_idx on public.webhook_events (received_at);

-- No policies at all, deliberately. This table is not scoped to any individual
-- user's data in a way RLS ownership patterns apply to, and has no legitimate
-- reason to ever be readable or writable by anon or authenticated.
alter table public.webhook_events enable row level security;

-- Explicit, even though RLS alone would already deny row access. Supabase
-- auto-grants SELECT/INSERT/UPDATE/DELETE on new public-schema tables directly
-- to anon and authenticated by default — the same platform behavior that
-- required an explicit REVOKE FROM anon, authenticated on
-- check_and_increment_usage and decrement_usage in earlier migrations; it
-- applies to tables, not just functions.
--
-- RLS and table-level grants are two separate authorization layers in Postgres.
-- Relying on RLS alone here would leave those roles holding a table-level grant
-- they have no legitimate use for, and would make the actual client-facing
-- behavior (empty result vs. permission error) depend on Supabase's
-- default-grant behavior rather than on an explicit decision in this migration.
-- The explicit REVOKE makes the outcome deterministic and makes the security
-- boundary visible here rather than implicit in platform defaults.
revoke all on public.webhook_events from anon, authenticated;
