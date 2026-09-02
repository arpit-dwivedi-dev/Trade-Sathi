import type { SurveyAnswers, SurveyDefinition, SurveyQuestion, SurveyStatus } from "@chartanalyzer/shared";
import { callRpc, supabaseAdmin } from "../lib/supabase.js";

interface SurveyRow {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  questions: unknown;
}

function toDefinition(row: SurveyRow): SurveyDefinition {
  // questions is stored as jsonb; the shape is only ever written by a
  // migration (see 20260902130100_profile_survey_credits.sql), so it is
  // trusted rather than re-validated field by field here.
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    questions: row.questions as SurveyQuestion[],
  };
}

/**
 * The survey the Account page should offer right now: the most recently
 * created active survey this user has not already completed, or null once
 * every active survey is done.
 *
 * Only ever one survey is "current" — there is no concept of a queue of
 * unfinished surveys to work through, just whatever is newest and unanswered.
 */
export async function getSurveyStatus(profileId: string): Promise<SurveyStatus> {
  const { data: completedRows, error: completedError } = await supabaseAdmin
    .from("survey_responses")
    .select("survey_id")
    .eq("profile_id", profileId);
  if (completedError) {
    throw completedError;
  }
  // The Supabase client here is not generated from this project's schema, so
  // `.select()` results type as `any` — this is the one place that is
  // asserted away, same reasoning as callRpc's single `any` in lib/supabase.ts.
  const completedSurveyIds = (completedRows ?? []) as { survey_id: string }[];
  const completedIds = new Set(completedSurveyIds.map((row) => row.survey_id));

  const { data: surveyRows, error: surveyError } = await supabaseAdmin
    .from("surveys")
    .select("id, slug, title, description, questions")
    .eq("is_active", true)
    .order("created_at", { ascending: false });
  if (surveyError) {
    throw surveyError;
  }

  const rows = (surveyRows ?? []) as SurveyRow[];
  const pending = rows.find((row) => !completedIds.has(row.id));
  if (!pending) {
    return { survey: null, completed: completedIds.size > 0 };
  }

  return { survey: toDefinition(pending), completed: false };
}

export type SubmitSurveyResult =
  | { ok: true; outcome: "applied" | "duplicate" }
  | { ok: false; reason: "survey_not_found" };

/**
 * Records a survey response and grants the completion credit, via the
 * submit_survey_response() RPC so the insert and the credit grant are one
 * atomic, idempotent operation — see that function for the reasoning.
 */
export async function submitSurveyResponse(
  profileId: string,
  surveyId: string,
  answers: SurveyAnswers,
): Promise<SubmitSurveyResult> {
  const outcome = await callRpc<"applied" | "duplicate" | "survey_not_found">(
    "submit_survey_response",
    { p_profile_id: profileId, p_survey_id: surveyId, p_answers: answers },
  );

  if (outcome === "survey_not_found") {
    return { ok: false, reason: "survey_not_found" };
  }
  return { ok: true, outcome };
}
