import { Router } from "express";
import { asyncRoute } from "../lib/async-route.js";
import { requireAuth } from "../middleware/auth.js";

export const meRouter = Router();

// Lets the frontend confirm a session is still valid, and echoes back the id
// the API resolved it to.
meRouter.get("/api/me", asyncRoute(requireAuth), (req, res) => {
  res.json({ profileId: req.profileId });
});
