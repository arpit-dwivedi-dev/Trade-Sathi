-- The fundamentals AI analysis contract.
--
-- apps/api/src/prompts/fundamentals-analysis.ts is a single, finalized prompt
-- (unlike the chart flow's vision/series pair), so it needs one payload column
-- rather than a union. Its TypeScript shape is
-- packages/shared/src/fundamentals-analysis.ts (`FundamentalsAnalysisResult`),
-- and apps/api validates every model response into exactly that shape
-- (apps/api/src/services/fundamentals-analysis-schema.ts) before it is
-- written here. Nothing else may write this column.
--
-- `fundamentals_stance` is promoted out of the payload for the same reason
-- `call_direction` is promoted out of `analysis_result`: it is what the
-- History list renders per row, and reading it out of jsonb for every row of
-- every page is the one thing the promotion buys.

create type fundamentals_stance as enum ('attractive', 'not_attractive', 'mixed');

alter table public.analyses
  add column fundamentals_result jsonb,
  add column fundamentals_stance fundamentals_stance;

comment on column public.analyses.fundamentals_result is
  'The validated fundamentals AI analysis payload — see FundamentalsAnalysisResult in packages/shared/src/fundamentals-analysis.ts. Null for every row except a completed source=''fundamentals'' analysis.';

-- Written by the service role only, exactly as analysis_result is; the
-- existing analyses_select_own policy already covers reading it, so no
-- policy change is needed here.
