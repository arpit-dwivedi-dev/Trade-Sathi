-- ChartAnalyzer — make a credit purchase's validation and its claim atomic.
--
-- Before this, createCreditOrder (apps/api/src/services/credits.service.ts)
-- validated a promo code with several separate reads, then created the
-- Razorpay order, then wrote the payments row. Three problems fell out of that
-- ordering, and they share one cause: none of those steps were in the same
-- transaction as any other.
--
--   1. Promo caps were counted from redemption_count and promo_redemptions,
--      both of which are only written at *capture*. Between creating an order
--      and paying it, the code was spoken for and every counter said otherwise.
--      A script firing N purchase requests at a once-per-account code had all
--      N see "zero used" and all N come back discounted.
--   2. The purchase bounds (min/max/step) were enforced in TypeScript, so the
--      rule the buyer was held to lived in application code rather than next to
--      the price it applies to.
--   3. The price was computed in TypeScript from a pricing row read in a
--      previous statement, so a repricing landing between the read and the
--      insert charged the old rate.
--
-- begin_credit_purchase does all of it in one transaction: it reads the
-- pricing row, enforces the bounds, takes a row lock on any promo code,
-- counts the caps, prices the order, and writes the 'created' payments row
-- before returning. The slot is claimed by that insert, inside the same
-- transaction as the lock that checked for it — which is the whole point, and
-- is the part the TypeScript could not do, because each statement it issued
-- was its own transaction.
--
-- The row it writes carries a null provider_order_id. That is not a
-- workaround: the column is nullable-but-unique precisely so a row may be
-- written before its order exists (see its comment in 20260830230000), and
-- the caller fills the id in once Razorpay answers. A row that never gets one
-- is an abandoned claim, and the caller deletes it.

-- ---------------------------------------------------------------------------
-- FUNCTION: begin_credit_purchase
-- ---------------------------------------------------------------------------

-- Returns a jsonb object, not a scalar, because a success has to hand back
-- several values at once (the payments row it wrote, the amount to charge, the
-- currency, the discount it applied) and a rejection has to say which rule was
-- hit. Scalar returns would have meant a second round trip for every one of
-- them, and a second round trip is a second transaction — which is the bug
-- this function exists to remove.
--
-- Return shapes:
--   { ok: true,  paymentId, amountMinor, discountMinor, currency, creditsRequested }
--   { ok: false, reason: 'region_unavailable' | 'below_minimum_purchase'
--                       | 'above_maximum_purchase' | 'invalid_quantity_step'
--                       | 'invalid_promo_code', <the limit that was missed> }
--
-- The limit fields (minCredits / maxCredits / stepCredits) ride along so the
-- caller can word the rejection without a second read of the pricing row.
--
-- SECURITY INVOKER, matching every other credit function here: the caller is
-- the backend on the service role, which already holds the privileges needed.
-- Under DEFINER, current_user would stop being service_role and Trigger C
-- (protect_profile_columns) would reject the writes. SET search_path = ''
-- hardens against search_path hijacking, so every reference is qualified.
create function public.begin_credit_purchase(
  p_profile_id uuid,
  p_region     pricing_region,
  p_quantity   int,
  p_promo_code text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  -- How long an unpaid order keeps holding a promo slot.
  --
  -- The cap check below counts orders that are holding the code but have not
  -- been paid, because those are exactly the ones the committed counters
  -- cannot see. That count has to expire, or a user who opened Checkout and
  -- changed their mind would have burned their one use of the code on an
  -- order they never paid — abandoned 'created' rows are left behind on
  -- purpose, so without a window they would hold their slot forever.
  --
  -- Matches PENDING_ORDER_MAX_AGE_MS in apps/web's billing.service.ts, which
  -- is the frontend's own "an order this old has been paid or never will be".
  -- Any concurrency this exists to close happens in seconds, so the window is
  -- generous by three orders of magnitude.
  claim_window constant interval := interval '30 minutes';

  v_pricing        public.credit_pricing_regions%rowtype;
  v_promo          public.promo_codes%rowtype;
  v_base_minor     int;
  v_discount_minor int := 0;
  v_promo_code_id  uuid := null;
  v_amount_minor   int;
  v_floor_minor    int;
  v_payment_id     uuid;
  v_in_flight      int;
  v_committed      int;
begin
  select * into v_pricing
  from public.credit_pricing_regions
  where region = p_region
    and is_active = true;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'region_unavailable');
  end if;

  -- The purchase bounds are enforced here and only here. The buy form clamps
  -- and snaps too, but that is a convenience for the honest user: nothing
  -- stops a caller posting to the endpoint directly, so a quantity outside
  -- [min, max] or off the increment has to be refused here or it is not
  -- refused at all.
  if p_quantity is null or p_quantity < v_pricing.min_purchase_credits then
    return jsonb_build_object(
      'ok', false,
      'reason', 'below_minimum_purchase',
      'minCredits', v_pricing.min_purchase_credits
    );
  end if;

  if p_quantity > v_pricing.max_purchase_credits then
    return jsonb_build_object(
      'ok', false,
      'reason', 'above_maximum_purchase',
      'maxCredits', v_pricing.max_purchase_credits
    );
  end if;

  -- Counted from the minimum, not from zero, so a region whose minimum is
  -- itself off the increment's grid still accepts its own minimum.
  if (p_quantity - v_pricing.min_purchase_credits) % v_pricing.purchase_increment_credits <> 0 then
    return jsonb_build_object(
      'ok', false,
      'reason', 'invalid_quantity_step',
      'stepCredits', v_pricing.purchase_increment_credits
    );
  end if;

  v_base_minor := p_quantity * v_pricing.price_per_credit_minor;

  -- -------------------------------------------------------------------------
  -- Promo code: validate and claim, under a lock.
  -- -------------------------------------------------------------------------

  if p_promo_code is not null and btrim(p_promo_code) <> '' then
    -- FOR UPDATE is what makes the caps hold. Two concurrent purchases of the
    -- same code serialize here, so the second one to arrive counts the first
    -- one's claimed order instead of racing past it. The lock is released when
    -- this transaction ends — after the payments row below has been written,
    -- which is what the next request will count.
    select * into v_promo
    from public.promo_codes
    where upper(code) = upper(btrim(p_promo_code))
    for update;

    -- Every rejection below is the same answer to the caller. Collapsing them
    -- deliberately: telling a caller which guessed codes used to be real, or
    -- exist but do something else, is a free enumeration oracle. A code with
    -- no discount component (free_credits only) lands here too — it is not
    -- invalid, it just has nothing to do at a checkout, and the redeem flow is
    -- where it belongs.
    if not found
      or not v_promo.is_active
      or (v_promo.discount_percent is null and v_promo.discount_fixed_minor is null)
    then
      return jsonb_build_object('ok', false, 'reason', 'invalid_promo_code');
    end if;

    if v_promo.starts_at is not null and now() < v_promo.starts_at then
      return jsonb_build_object('ok', false, 'reason', 'invalid_promo_code');
    end if;

    if v_promo.expires_at is not null and now() > v_promo.expires_at then
      return jsonb_build_object('ok', false, 'reason', 'invalid_promo_code');
    end if;

    if v_promo.region_eligibility is not null
      and array_length(v_promo.region_eligibility, 1) > 0
      and not (p_region = any (v_promo.region_eligibility))
    then
      return jsonb_build_object('ok', false, 'reason', 'invalid_promo_code');
    end if;

    if v_promo.min_purchase_amount_minor is not null
      and v_base_minor < v_promo.min_purchase_amount_minor
    then
      return jsonb_build_object('ok', false, 'reason', 'invalid_promo_code');
    end if;

    -- Global cap: everything already redeemed, plus everything currently
    -- holding a slot. redemption_count is the committed half (it is
    -- incremented by apply_credit_purchase at capture).
    select count(*) into v_in_flight
    from public.payments
    where promo_code_id = v_promo.id
      and status = 'created'
      and created_at > now() - claim_window;

    if v_promo.max_redemptions is not null
      and v_promo.redemption_count + v_in_flight >= v_promo.max_redemptions
    then
      return jsonb_build_object('ok', false, 'reason', 'invalid_promo_code');
    end if;

    -- Per-account cap: the same two halves, both scoped to this profile.
    select count(*) into v_in_flight
    from public.payments
    where promo_code_id = v_promo.id
      and profile_id = p_profile_id
      and status = 'created'
      and created_at > now() - claim_window;

    select count(*) into v_committed
    from public.promo_redemptions
    where code_id = v_promo.id
      and profile_id = p_profile_id
      and redemption_type = 'discount';

    if v_in_flight + v_committed >= v_promo.per_user_limit then
      return jsonb_build_object('ok', false, 'reason', 'invalid_promo_code');
    end if;

    if v_promo.discount_percent is not null then
      v_discount_minor := round(v_base_minor * v_promo.discount_percent / 100.0)::int;
      if v_promo.max_discount_amount_minor is not null then
        v_discount_minor := least(v_discount_minor, v_promo.max_discount_amount_minor);
      end if;
    else
      v_discount_minor := least(coalesce(v_promo.discount_fixed_minor, 0), v_base_minor);
    end if;

    v_promo_code_id := v_promo.id;
  end if;

  -- Razorpay's documented minimum order amount, per currency. The buyer
  -- already cleared the minimum-purchase gate above, so a discount that would
  -- otherwise take the order below this floor is clamped rather than rejected:
  -- the order still goes through, just without discounting past what the
  -- provider allows.
  v_floor_minor := case p_region when 'IN' then 100 else 50 end;
  if v_base_minor - v_discount_minor < v_floor_minor then
    v_discount_minor := greatest(0, v_base_minor - v_floor_minor);
  end if;

  v_amount_minor := v_base_minor - v_discount_minor;

  -- The claim. Written here, still holding the promo lock, so that the count
  -- the next request performs sees it. provider_order_id stays null until the
  -- caller has an order id to put in it; status='created' and
  -- signature_verified=false are the honest state right now — nothing has
  -- been paid and no signature has been checked.
  insert into public.payments (
    profile_id,
    provider_order_id,
    credits_purchased,
    base_amount_minor,
    discount_minor,
    amount_minor,
    currency,
    promo_code_id,
    status
  ) values (
    p_profile_id,
    null,
    p_quantity,
    v_base_minor,
    v_discount_minor,
    v_amount_minor,
    v_pricing.currency,
    v_promo_code_id,
    'created'
  )
  returning id into v_payment_id;

  return jsonb_build_object(
    'ok', true,
    'paymentId', v_payment_id,
    'amountMinor', v_amount_minor,
    'discountMinor', v_discount_minor,
    'currency', v_pricing.currency,
    'creditsRequested', p_quantity
  );
end;
$$;

-- Server-side only, same reasoning as every other credit function: a client
-- able to call this could mint itself discounted orders, and could claim promo
-- slots it has no right to.
--
-- anon and authenticated are revoked explicitly, not just via PUBLIC —
-- Supabase auto-grants EXECUTE on new public-schema functions directly to both
-- roles, so those grants are held in their own right and would survive a
-- revoke from PUBLIC alone.
revoke execute on function
  public.begin_credit_purchase(uuid, pricing_region, int, text)
  from public, anon, authenticated;

grant execute on function
  public.begin_credit_purchase(uuid, pricing_region, int, text)
  to service_role;
