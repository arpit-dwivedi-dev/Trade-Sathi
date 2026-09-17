-- TradeSathi — credit purchase bounds, as config.
--
-- Three changes to credit_pricing_regions, all of them numbers, per that
-- table's own rule that repricing never requires a code change.
--
-- 1. min_purchase_credits and quick_amounts_minor are re-derived so that
--    every quantity the UI can offer is a multiple of
--    purchase_increment_credits. The old values were sized from round rupee
--    and dollar amounts (₹199, $4.99), and dividing those by the per-credit
--    price is what put them off the grid — min 22 IN / 41 GLOBAL, quick
--    22/55/111/222 and 41/83/166/416.
--      IN     ₹9.00/credit → ₹225, ₹495, ₹990, ₹1,980      = 25, 55, 110, 220
--      GLOBAL $0.12/credit → $5.40, $10.20, $19.80, $50.40 = 45, 85, 165, 420
--
-- 2. max_purchase_credits is new. There was previously no upper bound at
--    all: createCreditOrder checked only the minimum, so any quantity a
--    client chose to send was accepted. 5000 credits is ₹45,000 IN and
--    $600 GLOBAL — lower the GLOBAL row if that band reads too wide.
--
-- 3. purchase_increment_credits is the step, held in config rather than
--    hardcoded in the buy form, so the stepper's step and the server's
--    validation cannot drift apart.
--
-- Together these mean a quantity is valid iff
--   min <= q <= max  and  (q - min) % increment = 0
-- which is exactly what createCreditOrder now enforces.

alter table public.credit_pricing_regions
  add column max_purchase_credits int not null default 5000
    check (max_purchase_credits > 0),
  add column purchase_increment_credits int not null default 5
    check (purchase_increment_credits > 0);

update public.credit_pricing_regions
set min_purchase_credits = 25,
    quick_amounts_minor = array[22500, 49500, 99000, 198000],
    max_purchase_credits = 5000,
    purchase_increment_credits = 5,
    updated_at = now()
where region = 'IN';

update public.credit_pricing_regions
set min_purchase_credits = 45,
    quick_amounts_minor = array[540, 1020, 1980, 5040],
    max_purchase_credits = 5000,
    purchase_increment_credits = 5,
    updated_at = now()
where region = 'GLOBAL';

-- Added after the updates so the constraint is validated against the values
-- this migration actually leaves in place, not the ones it replaced.
alter table public.credit_pricing_regions
  add constraint credit_pricing_regions_bounds
    check (max_purchase_credits >= min_purchase_credits);
