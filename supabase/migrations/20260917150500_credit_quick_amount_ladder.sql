-- TradeSathi — the quick-select ladder, as credits rather than as money.
--
-- quick_amounts_minor is what the buy form's chips show. The values it has
-- carried were sized backwards: a round amount of money (₹199, $4.99) divided
-- by the per-credit price, which is what produced chips reading 22/55/111/222
-- and 41/83/166/416. Nobody buys 222 of anything, and every one of those
-- numbers has to be divided by the per-credit price before it means anything.
--
-- Sized from the credits instead: 25 / 50 / 100 / 500, which spans "a few
-- analyses" to "a year of them" and reads as a ladder at a glance. The chip's
-- label is the credit count the API derives from the amount, so each entry
-- below is credits × price_per_credit_minor exactly — the API's
-- floor(amount ÷ price) lands on the ladder and the form's snap has nothing
-- left to correct:
--   IN     ₹9.00/credit → ₹225, ₹450, ₹900, ₹4,500   = 25, 50, 100, 500
--   GLOBAL $0.12/credit → $6.00, $12.00, $60.00      = 50, 100, 500
--
-- GLOBAL carries three, not four. 25 credits is $3.00 there, under that
-- region's 45-credit minimum, and a chip below the minimum does not fail — the
-- form snaps it up to the boundary, so the chip would have read "45" while the
-- configured amount said 25. The smallest GLOBAL chip is therefore the first
-- round quantity its own minimum admits.
--
-- Nothing else changes: min_purchase_credits, max_purchase_credits and
-- purchase_increment_credits are left as the previous migration set them, and
-- every amount above is on its region's grid — a multiple of the 5-credit
-- increment from that region's minimum. These are still display sugar only:
-- any quantity on the grid can be typed directly, and none of them is a SKU.

update public.credit_pricing_regions
set quick_amounts_minor = array[22500, 45000, 90000, 450000],
    updated_at = now()
where region = 'IN';

update public.credit_pricing_regions
set quick_amounts_minor = array[600, 1200, 6000],
    updated_at = now()
where region = 'GLOBAL';
