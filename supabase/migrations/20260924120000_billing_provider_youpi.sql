-- TradeSathi — allow payments to be recorded against YouPI PG.
--
-- payments.provider is the billing_provider enum, which only knew 'razorpay'.
-- createCreditOrder sets provider = 'youpi' on a row once a YouPI session has
-- been created for it (apps/api/src/services/credits.service.ts), and the YouPI
-- webhook only resolves rows carrying that value.
--
-- Its own migration because a new enum value cannot be used in the same
-- transaction that adds it. Existing rows and the column default are untouched.
alter type public.billing_provider add value if not exists 'youpi';
