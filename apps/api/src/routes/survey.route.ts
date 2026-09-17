import { Router, type Request, type Response } from "express";
import type { SurveyAnswers } from "@tradesathi/shared";
import { asyncRoute } from "../lib/async-route.js";
import { logger } from "../lib/logger.js";
import { requireAuth } from "../middleware/auth.js";
import { getSurveyStatus, submitSurveyResponse } from "../services/survey.service.js";

export const surveyRouter = Router();

surveyRouter.get(
  "/api/survey",
  asyncRoute(requireAuth),
  asyncRoute(async (req: Request, res: Response) => {
    // Non-null: requireAuth ran before this handler and only calls next()
    // after setting profileId.
    const status = await getSurveyStatus(req.profileId!);
    res.json(status);
  }),
);

function isSurveyAnswers(value: unknown): value is SurveyAnswers {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((v) => typeof v === "string");
}

surveyRouter.post(
  "/api/survey/:surveyId/responses",
  asyncRoute(requireAuth),
  asyncRoute(async (req: Request, res: Response) => {
    const { surveyId } = req.params;
    const { answers } = (req.body ?? {}) as { answers?: unknown };
    if (!isSurveyAnswers(answers) || Object.keys(answers).length === 0) {
      res.status(400).json({ error: "answers must be a non-empty map of question id to string" });
      return;
    }

    try {
      // Non-null: requireAuth ran before this handler and only calls next()
      // after setting profileId.
      const result = await submitSurveyResponse(req.profileId!, surveyId, answers);
      if (!result.ok) {
        res.status(404).json({ error: "Survey not found" });
        return;
      }
      res.json({ outcome: result.outcome });
    } catch (cause) {
      logger.error("failed to submit survey response", {
        profileId: req.profileId,
        surveyId,
        cause: String(cause),
      });
      res.status(500).json({ error: "Failed to submit survey response" });
    }
  }),
);
