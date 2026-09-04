-- Audit trail for the fundamentals verification middle layer
-- (apps/api/src/services/fundamentals-verification.service.ts), which sits
-- between the raw yFinance fundamentals fetch and the existing, unmodified
-- fundamentals AI prompt/schema.
--
-- Nullable and purely additive: null means verification was disabled, ran
-- into no priority-field issues worth recording, or failed and was
-- swallowed (verifier failure must never block the analysis pipeline). See
-- VerificationResult in apps/api/src/lib/verification/types.ts for the
-- shape written here.

alter table public.analyses
  add column fundamentals_verification jsonb;

comment on column public.analyses.fundamentals_verification is
  'Best-effort verification/audit trail for the fundamentals payload fed to the AI — see VerificationResult in apps/api/src/lib/verification/types.ts. Null when verification was disabled, not applicable, or failed.';

-- Written by the service role only; the existing analyses_select_own policy
-- already covers reading it, so no policy change is needed here.
