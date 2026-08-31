import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { searchInstruments } from "../services/instruments.service.js";

export const instrumentsRouter = Router();

instrumentsRouter.get("/api/instruments/search", requireAuth, async (req, res) => {
  const q = typeof req.query["q"] === "string" ? req.query["q"] : "";
  if (q.trim().length < 2) {
    res.json({ instruments: [] });
    return;
  }

  try {
    const instruments = await searchInstruments(q);
    res.json({ instruments });
  } catch {
    res.status(500).json({ error: "Instrument search failed" });
  }
});
