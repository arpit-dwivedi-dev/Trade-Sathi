-- ChartAnalyzer — unified credit billing, part 4: seed data.
--
-- Numbers derived in the approved credit-billing redesign plan, from real
-- logged AI cost (public.analyses.cost_usd/input_tokens/output_tokens,
-- queried directly: 150 completed rows) plus assumed Razorpay fee (3% IN /
-- 4% GLOBAL, incl. 18% GST on the fee) and an 80% target gross margin. Both
-- the fee assumption and the 1 USD ≈ ₹83 FX reference used to size the
-- GLOBAL band were not found anywhere in this codebase — confirm against the
-- live Razorpay merchant rate and current FX before treating these as final.
-- Both tables are pure config: changing a number here never requires a code
-- change.
--
-- price_per_credit_minor derivation: cost_ceiling / (1 - fee% - margin%),
-- using Fundamental Analysis's cost ceiling ($0.018/call) as the binding
-- constraint — it is the most expensive single-credit action, so every
-- cheaper feature (chart analysis, daily briefing) clears the same margin
-- target with room to spare.
--   IN:     0.018 / (1 - 0.03 - 0.80) = $0.1059 floor -> ₹9.00/credit  (~80.4% effective margin)
--   GLOBAL: 0.018 / (1 - 0.04 - 0.80) = $0.1125 floor -> $0.12/credit (~81%   effective margin)

insert into public.feature_credit_costs (feature_key, credits) values
  ('chart_analysis',       1),
  ('daily_briefing_run',   2),  -- per watchlist symbol, per scheduled/manual run
  ('fundamental_analysis', 1);

insert into public.credit_pricing_regions
  (region, currency, price_per_credit_minor, min_purchase_credits, quick_amounts_minor)
values
  ('IN',     'INR', 900, 22, array[19900, 49900, 99900, 199900]),
  ('GLOBAL', 'USD',  12, 41, array[499, 999, 1999, 4999]);
