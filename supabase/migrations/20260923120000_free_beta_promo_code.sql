-- The free-beta credit code.
--
-- Purchases are paused (BILLING_ENABLED, apps/api/src/lib/env.ts) until a
-- payment gateway approves Trade Sathi's own website, so during the free beta
-- this code is how every account gets its credits: BETA5, redeemable once per
-- account for 5 credits.
--
-- No global cap and no expiry, so every new signup can use it. Set
-- max_redemptions or expires_at on this row to close the beta, or
-- is_active = false to switch the code off. The web app prints the code on
-- the landing page and in the app (apps/web/src/app/features/billing/free-beta.ts),
-- so a change to the code itself has to be made in both places.
--
-- ON CONFLICT against promo_codes_code_ci_idx, the case-insensitive unique
-- index: re-running this against a database that already holds the code
-- changes nothing.

insert into public.promo_codes (code, free_credits, per_user_limit)
values ('BETA5', 5, 1)
on conflict ((upper(code))) do nothing;
