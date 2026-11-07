-- TradeSathi — credit purchases paid by UPI QR to the owner's own VPA,
-- confirmed from bank SMS forwarded by the "SMS to URL Forwarder" Android app.
--
-- How a purchase works:
--   1. begin_upi_credit_purchase reuses begin_credit_purchase (pricing, bounds,
--      promo caps — unchanged) and then turns the 'created' row it wrote into
--      a UPI order: our own reference in provider_order_id, an expiry, and a
--      payable amount that is UNIQUE among open UPI orders.
--   2. The buyer pays that exact amount. The bank texts the owner's phone; the
--      forwarder posts it to /api/webhooks/sms; the API parses it with the
--      configured rules and stores it in upi_sms_messages.
--   3. match_upi_sms ties the SMS to an order and settles it through the
--      existing apply_credit_purchase, so the balance movement, ledger row,
--      promo bookkeeping and idempotency guard are the same ones a Razorpay
--      capture uses.
--
-- Why a unique amount. The buyer is asked to do nothing but pay, and a bank's
-- credit SMS does not carry our order reference (the UPI note is not in it),
-- so the amount is the only thing the buyer controls that reaches the SMS.
-- Making it unique per open order turns it into the order's identifier. It is
-- never the only check: the SMS must also come from a configured bank sender,
-- match a credit rule, carry a UTR never seen before, optionally name the
-- configured account, and have been received inside that order's window. An
-- SMS that fails any of these is kept for an admin to look at, not credited.
--
-- The amount is made unique by taking 0–99 paise OFF the price, never adding,
-- so a buyer never pays more than the list price. The paise taken off are
-- folded into discount_minor so amount_minor = base_amount_minor -
-- discount_minor stays true; a promo-discounted order's
-- promo_redemptions.discount_applied_minor therefore includes those paise too.
--
-- SMS-based confirmation is a prototype-grade signal, not a bank API: a forged
-- SMS on the owner's phone, or a stranger paying the same odd amount inside the
-- same 15-minute window, would be believed. See docs/upi-sms-payments.md.

-- ---------------------------------------------------------------------------
-- 1. payments — expiry, and the uniqueness the amount-as-identifier relies on
-- ---------------------------------------------------------------------------

-- Null for Razorpay orders, which expire on Razorpay's side.
alter table public.payments add column expires_at timestamptz;

comment on column public.payments.expires_at is
  'UPI orders only: after this the QR is no longer shown. A bank SMS received up to UPI_SMS_GRACE_MINUTES later still settles the order, because SMS delivery can lag.';

-- Backstop for the allocation in begin_upi_credit_purchase, which also keeps
-- an amount reserved for the grace period after its order expires (something
-- a partial index cannot express, since it cannot mention now()).
create unique index payments_upi_open_amount_idx
  on public.payments (amount_minor)
  where provider = 'upi_direct' and status = 'created';

-- 'expired' joins 'created' | 'captured' | 'failed' | 'refunded' as a status
-- value. The column is free text with no check constraint, so nothing to alter.

-- ---------------------------------------------------------------------------
-- 2. TABLE: upi_sms_messages — every forwarded bank SMS, parsed
-- ---------------------------------------------------------------------------

create table public.upi_sms_messages (
  id            uuid primary key default gen_random_uuid(),
  -- The SMS sender id as the phone reports it, e.g. a DLT header.
  sender        text not null,
  -- The full SMS text. Sensitive (balances, account digits): no client policy
  -- below, read only by the service role for the admin review queue.
  body          text not null,
  -- sha256(sender, body, sent stamp). The forwarder retries failed
  -- deliveries, and a retry must not become a second row.
  dedupe_key    text not null unique,
  sent_at       timestamptz,
  -- When the phone received it (falls back to arrival time at the API). This,
  -- not created_at, is what is held against an order's window.
  received_at   timestamptz not null,
  created_at    timestamptz not null default now(),
  -- Which configured rule parsed it; null when none applied.
  rule_name     text,
  parse_status  text not null check (parse_status in ('credit', 'not_credit', 'unparsed', 'rejected')),
  -- Why it was unparsed/rejected, in words an admin can act on.
  parse_note    text,
  amount_minor  int check (amount_minor > 0),
  utr           text,
  account_hint  text,
  payer_hint    text,
  match_status  text not null default 'pending'
                check (match_status in ('pending', 'matched', 'unmatched', 'ambiguous', 'not_applicable', 'ignored')),
  payment_id    uuid references public.payments(id) on delete set null,
  matched_by    text check (matched_by in ('auto', 'auto_payer_hint', 'admin')),
  reviewed_by   uuid references public.profiles(id) on delete set null,
  reviewed_at   timestamptz,
  review_note   text,
  constraint upi_sms_credit_has_fields check (
    parse_status <> 'credit' or (amount_minor is not null and utr is not null)
  )
);

-- UTR idempotency. One bank transfer has one UTR; a second SMS carrying it
-- (a duplicate text, a retry with a different stamp) is the same payment and
-- must not settle anything twice.
create unique index upi_sms_messages_utr_idx
  on public.upi_sms_messages (utr)
  where utr is not null;

create index upi_sms_messages_review_idx
  on public.upi_sms_messages (match_status, created_at desc);

alter table public.upi_sms_messages enable row level security;
-- No policies: service role only.

-- ---------------------------------------------------------------------------
-- 3. TABLE: upi_payment_events — the audit log
-- ---------------------------------------------------------------------------

-- Append-only. payments/credit_ledger record the outcome; this records how it
-- was reached and who decided: which SMS settled which order, which ones did
-- not match and why, and every admin action.
create table public.upi_payment_events (
  id               uuid primary key default gen_random_uuid(),
  payment_id       uuid references public.payments(id) on delete set null,
  sms_id           uuid references public.upi_sms_messages(id) on delete set null,
  event            text not null,
  actor            text not null check (actor in ('system', 'buyer', 'admin')),
  actor_profile_id uuid references public.profiles(id) on delete set null,
  detail           jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);

create index upi_payment_events_payment_idx on public.upi_payment_events (payment_id, created_at);
create index upi_payment_events_sms_idx on public.upi_payment_events (sms_id, created_at);

alter table public.upi_payment_events enable row level security;
-- No policies: service role only.

-- ---------------------------------------------------------------------------
-- 4. FUNCTION: begin_upi_credit_purchase
-- ---------------------------------------------------------------------------

-- Returns begin_credit_purchase's rejection unchanged, or one of its own:
--   { ok: false, reason: 'region_unavailable' }  — region does not bill in INR
--   { ok: false, reason: 'busy' }                — all 100 paise slots under
--                                                  this price are taken
--   { ok: true, paymentId, reference, amountMinor, priceMinor, currency,
--     creditsRequested, expiresAt }
--
-- priceMinor is the price before the paise offset (after any promo), so the
-- UI can say what was taken off and why.
--
-- p_reuse_after is how long an expired order's amount stays reserved — the
-- SMS grace period, so a late SMS can only ever point at one order.
create function public.begin_upi_credit_purchase(
  p_profile_id  uuid,
  p_region      pricing_region,
  p_quantity    int,
  p_promo_code  text,
  p_reference   text,
  p_ttl         interval,
  p_reuse_after interval
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_claim      jsonb;
  v_payment_id uuid;
  v_price      int;
  v_offset     int;
  v_amount     int;
  v_expires    timestamptz;
begin
  -- Serializes amount allocation. Two concurrent purchases at the same price
  -- would otherwise both see the same free slot; the unique index would stop
  -- the second one, but as an error rather than as the next free slot.
  perform pg_advisory_xact_lock(hashtextextended('tradesathi.upi_amount_allocation', 0));

  -- Expiry is applied lazily, here, rather than by a scheduler: this is the
  -- only place that needs it to be current. The buyer's own open orders are
  -- expired too — a new QR replaces the old one — which also stops one person
  -- holding many amount slots. Their expires_at moves to now so a late SMS for
  -- them still lands inside the grace period.
  update public.payments
  set status     = 'expired',
      expires_at = least(expires_at, now())
  where provider = 'upi_direct'
    and status = 'created'
    and (expires_at <= now() or profile_id = p_profile_id);

  v_claim := public.begin_credit_purchase(p_profile_id, p_region, p_quantity, p_promo_code);
  if not (v_claim ->> 'ok')::boolean then
    return v_claim;
  end if;

  v_payment_id := (v_claim ->> 'paymentId')::uuid;
  v_price      := (v_claim ->> 'amountMinor')::int;

  -- UPI moves rupees only.
  if v_claim ->> 'currency' <> 'INR' then
    delete from public.payments where id = v_payment_id;
    return jsonb_build_object('ok', false, 'reason', 'region_unavailable');
  end if;

  -- The smallest paise offset whose amount no open order, and no order still
  -- inside its SMS grace period, is using. Never below ₹1.
  select o into v_offset
  from generate_series(0, 99) as o
  where v_price - o >= 100
    and not exists (
      select 1
      from public.payments p
      where p.provider = 'upi_direct'
        and p.id <> v_payment_id
        and p.amount_minor = v_price - o
        and (
          p.status = 'created'
          or (p.status = 'expired' and p.expires_at > now() - p_reuse_after)
        )
    )
  order by o
  limit 1;

  if v_offset is null then
    delete from public.payments where id = v_payment_id;
    return jsonb_build_object('ok', false, 'reason', 'busy');
  end if;

  v_amount  := v_price - v_offset;
  v_expires := now() + p_ttl;

  update public.payments
  set provider          = 'upi_direct',
      provider_order_id = p_reference,
      amount_minor      = v_amount,
      discount_minor    = discount_minor + v_offset,
      expires_at        = v_expires
  where id = v_payment_id;

  insert into public.upi_payment_events (payment_id, event, actor, actor_profile_id, detail)
  values (
    v_payment_id, 'order_created', 'buyer', p_profile_id,
    jsonb_build_object(
      'reference', p_reference,
      'amountMinor', v_amount,
      'offsetMinor', v_offset,
      'credits', p_quantity,
      'expiresAt', v_expires
    )
  );

  return jsonb_build_object(
    'ok', true,
    'paymentId', v_payment_id,
    'reference', p_reference,
    'amountMinor', v_amount,
    'priceMinor', v_price,
    'currency', 'INR',
    'creditsRequested', p_quantity,
    'expiresAt', v_expires
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. FUNCTION: settle_upi_payment_from_sms
-- ---------------------------------------------------------------------------

-- Settles one order from one parsed credit SMS. Used by the automatic matcher
-- and by an admin linking an SMS by hand; both get the same checks, so an
-- admin cannot settle an order from an SMS for a different amount.
--
-- Returns { outcome: 'matched', paymentId, profileId } or
-- { outcome: 'sms_not_found' | 'sms_not_credit' | 'sms_already_matched'
--          | 'payment_not_found' | 'payment_already_paid' | 'amount_mismatch' }.
create function public.settle_upi_payment_from_sms(
  p_sms_id     uuid,
  p_payment_id uuid,
  p_matched_by text,
  p_admin_id   uuid,
  p_note       text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_sms     public.upi_sms_messages%rowtype;
  v_payment public.payments%rowtype;
  v_applied text;
begin
  -- Lock order everywhere: SMS row, then payment row.
  select * into v_sms from public.upi_sms_messages where id = p_sms_id for update;
  if not found then
    return jsonb_build_object('outcome', 'sms_not_found');
  end if;
  -- A 'rejected' SMS (say, the account check failed because UPI_ACCOUNT_LAST4
  -- is wrong) can still be settled, but only by an admin who has looked at it.
  if v_sms.amount_minor is null
    or v_sms.utr is null
    or not (
      v_sms.parse_status = 'credit'
      or (v_sms.parse_status = 'rejected' and p_matched_by = 'admin')
    )
  then
    return jsonb_build_object('outcome', 'sms_not_credit');
  end if;
  if v_sms.match_status in ('matched', 'ignored') then
    return jsonb_build_object('outcome', 'sms_already_matched');
  end if;

  select * into v_payment from public.payments where id = p_payment_id for update;
  if not found or v_payment.provider <> 'upi_direct' then
    return jsonb_build_object('outcome', 'payment_not_found');
  end if;
  if v_payment.status = 'captured' then
    return jsonb_build_object('outcome', 'payment_already_paid');
  end if;
  if v_payment.amount_minor <> v_sms.amount_minor or v_payment.currency <> 'INR' then
    return jsonb_build_object('outcome', 'amount_mismatch');
  end if;

  -- The same grant a Razorpay capture uses. signature_verified = false: there
  -- is no signature here, and the column must not claim one. The UTR becomes
  -- provider_payment_id, whose unique constraint is a second guard against
  -- one transfer settling two orders.
  v_applied := public.apply_credit_purchase(v_payment.provider_order_id, v_sms.utr, false);
  if v_applied <> 'applied' then
    -- Unreachable while the row lock above is held; reported, not hidden.
    return jsonb_build_object('outcome', 'payment_already_paid');
  end if;

  update public.upi_sms_messages
  set match_status = 'matched',
      payment_id   = v_payment.id,
      matched_by   = p_matched_by,
      reviewed_by  = p_admin_id,
      reviewed_at  = case when p_admin_id is null then null else now() end,
      review_note  = p_note
  where id = v_sms.id;

  insert into public.upi_payment_events (payment_id, sms_id, event, actor, actor_profile_id, detail)
  values (
    v_payment.id, v_sms.id,
    case when p_matched_by = 'admin' then 'admin_matched' else 'auto_matched' end,
    case when p_admin_id is null then 'system' else 'admin' end,
    p_admin_id,
    jsonb_build_object(
      'utr', v_sms.utr,
      'amountMinor', v_sms.amount_minor,
      'matchedBy', p_matched_by,
      'note', p_note
    )
  );

  return jsonb_build_object(
    'outcome', 'matched',
    'paymentId', v_payment.id,
    'profileId', v_payment.profile_id
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. FUNCTION: match_upi_sms — the automatic matcher
-- ---------------------------------------------------------------------------

-- Returns { outcome, ... }:
--   'matched'        — settled; paymentId, profileId
--   'duplicate'      — its UTR already settled an order (an admin marked it
--                      paid by hand first); linked to that payment
--   'unmatched'      — no open order has this amount inside its window
--   'ambiguous'      — more than one does; candidateIds for the caller's
--                      tie-break, and for the admin queue otherwise
--   'not_applicable' — not a parsed credit SMS
--   or the SMS's current match_status when it was already decided.
create function public.match_upi_sms(p_sms_id uuid, p_grace interval)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_sms      public.upi_sms_messages%rowtype;
  v_existing uuid;
  v_ids      uuid[];
  v_result   jsonb;
begin
  select * into v_sms from public.upi_sms_messages where id = p_sms_id for update;
  if not found then
    return jsonb_build_object('outcome', 'sms_not_found');
  end if;

  if v_sms.parse_status <> 'credit' then
    update public.upi_sms_messages
    set match_status = 'not_applicable'
    where id = v_sms.id and match_status = 'pending';
    return jsonb_build_object('outcome', 'not_applicable');
  end if;

  if v_sms.match_status not in ('pending', 'unmatched', 'ambiguous') then
    return jsonb_build_object('outcome', v_sms.match_status, 'paymentId', v_sms.payment_id);
  end if;

  select id into v_existing from public.payments where provider_payment_id = v_sms.utr;
  if found then
    update public.upi_sms_messages
    set match_status = 'matched',
        payment_id   = v_existing,
        matched_by   = 'auto',
        review_note  = 'This UTR had already settled the order'
    where id = v_sms.id;
    insert into public.upi_payment_events (payment_id, sms_id, event, actor, detail)
    values (v_existing, v_sms.id, 'sms_utr_already_applied', 'system',
            jsonb_build_object('utr', v_sms.utr));
    return jsonb_build_object('outcome', 'duplicate', 'paymentId', v_existing);
  end if;

  -- 'expired' is included on purpose: an SMS can arrive after the QR timed
  -- out for a payment made before it did. The window is what decides — the
  -- SMS must have been received after the order existed (two minutes of slack
  -- for a phone clock running behind) and before its expiry plus the grace.
  select array_agg(p.id order by p.created_at) into v_ids
  from public.payments p
  where p.provider = 'upi_direct'
    and p.status in ('created', 'expired')
    and p.currency = 'INR'
    and p.amount_minor = v_sms.amount_minor
    and v_sms.received_at >= p.created_at - interval '2 minutes'
    and v_sms.received_at <= p.expires_at + p_grace;

  if coalesce(array_length(v_ids, 1), 0) = 0 then
    update public.upi_sms_messages set match_status = 'unmatched' where id = v_sms.id;
    insert into public.upi_payment_events (sms_id, event, actor, detail)
    values (v_sms.id, 'sms_unmatched', 'system',
            jsonb_build_object('amountMinor', v_sms.amount_minor, 'utr', v_sms.utr));
    return jsonb_build_object('outcome', 'unmatched');
  end if;

  if array_length(v_ids, 1) > 1 then
    update public.upi_sms_messages set match_status = 'ambiguous' where id = v_sms.id;
    insert into public.upi_payment_events (sms_id, event, actor, detail)
    values (v_sms.id, 'sms_ambiguous', 'system',
            jsonb_build_object('candidateIds', to_jsonb(v_ids)));
    return jsonb_build_object('outcome', 'ambiguous', 'candidateIds', to_jsonb(v_ids));
  end if;

  v_result := public.settle_upi_payment_from_sms(v_sms.id, v_ids[1], 'auto', null, null);

  if v_result ->> 'outcome' <> 'matched' then
    -- Lost a race (another SMS settled this order first — the buyer may have
    -- paid twice). Left for an admin, who may need to refund one of them.
    update public.upi_sms_messages
    set match_status = 'unmatched',
        review_note  = 'Matched an order that was settled meanwhile: ' || (v_result ->> 'outcome')
    where id = v_sms.id;
    insert into public.upi_payment_events (payment_id, sms_id, event, actor, detail)
    values (v_ids[1], v_sms.id, 'sms_unmatched', 'system', v_result);
    return jsonb_build_object('outcome', 'unmatched');
  end if;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. FUNCTION: admin_mark_upi_paid — settle with no SMS at all
-- ---------------------------------------------------------------------------

-- For when the SMS never arrived (phone off, forwarder down) and the admin has
-- checked the bank statement by hand. Refuses a UTR that any SMS carries —
-- that SMS should be linked instead, which also checks its amount.
--
-- Returns { outcome: 'applied' | 'payment_not_found' | 'payment_already_paid'
--                    | 'utr_already_used' | 'utr_has_sms' }.
create function public.admin_mark_upi_paid(
  p_payment_id uuid,
  p_utr        text,
  p_admin_id   uuid,
  p_note       text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_payment public.payments%rowtype;
  v_applied text;
begin
  select * into v_payment from public.payments where id = p_payment_id for update;
  if not found or v_payment.provider <> 'upi_direct' then
    return jsonb_build_object('outcome', 'payment_not_found');
  end if;
  if v_payment.status = 'captured' then
    return jsonb_build_object('outcome', 'payment_already_paid');
  end if;
  if exists (select 1 from public.payments where provider_payment_id = p_utr) then
    return jsonb_build_object('outcome', 'utr_already_used');
  end if;
  if exists (select 1 from public.upi_sms_messages where utr = p_utr) then
    return jsonb_build_object('outcome', 'utr_has_sms');
  end if;

  v_applied := public.apply_credit_purchase(v_payment.provider_order_id, p_utr, false);
  if v_applied <> 'applied' then
    return jsonb_build_object('outcome', 'payment_already_paid');
  end if;

  insert into public.upi_payment_events (payment_id, event, actor, actor_profile_id, detail)
  values (v_payment.id, 'admin_marked_paid', 'admin', p_admin_id,
          jsonb_build_object('utr', p_utr, 'amountMinor', v_payment.amount_minor, 'note', p_note));

  return jsonb_build_object('outcome', 'applied');
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. FUNCTION: admin_ignore_upi_sms
-- ---------------------------------------------------------------------------

-- Takes an SMS out of the review queue (a refund, a personal transfer, a
-- message that is not a payment at all). Returns false when there was nothing
-- to ignore — no such SMS, or one that already settled an order.
create function public.admin_ignore_upi_sms(
  p_sms_id   uuid,
  p_admin_id uuid,
  p_note     text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.upi_sms_messages
  set match_status = 'ignored',
      reviewed_by  = p_admin_id,
      reviewed_at  = now(),
      review_note  = p_note
  where id = p_sms_id
    and match_status <> 'matched';

  if not found then
    return false;
  end if;

  insert into public.upi_payment_events (sms_id, event, actor, actor_profile_id, detail)
  values (p_sms_id, 'admin_ignored', 'admin', p_admin_id, jsonb_build_object('note', p_note));

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- PERMISSIONS
-- ---------------------------------------------------------------------------

-- Server-side only, like every other function that moves credits. anon and
-- authenticated are revoked explicitly because Supabase grants EXECUTE on new
-- public-schema functions to both directly, not only through PUBLIC.
revoke execute on function
  public.begin_upi_credit_purchase(uuid, pricing_region, int, text, text, interval, interval),
  public.settle_upi_payment_from_sms(uuid, uuid, text, uuid, text),
  public.match_upi_sms(uuid, interval),
  public.admin_mark_upi_paid(uuid, text, uuid, text),
  public.admin_ignore_upi_sms(uuid, uuid, text)
  from public, anon, authenticated;

grant execute on function
  public.begin_upi_credit_purchase(uuid, pricing_region, int, text, text, interval, interval),
  public.settle_upi_payment_from_sms(uuid, uuid, text, uuid, text),
  public.match_upi_sms(uuid, interval),
  public.admin_mark_upi_paid(uuid, text, uuid, text),
  public.admin_ignore_upi_sms(uuid, uuid, text)
  to service_role;
