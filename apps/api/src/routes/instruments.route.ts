import { isMarketCode } from "@tradesathi/shared";
import { Router } from "express";
import { asyncRoute } from "../lib/async-route.js";
import { requireAuth } from "../middleware/auth.js";
import { searchInstruments } from "../services/instruments.service.js";

export const instrumentsRouter = Router();

instrumentsRouter.get(
  "/api/instruments/search",
  asyncRoute(requireAuth),
  asyncRoute(async (req, res) => {
    const q = typeof req.query["q"] === "string" ? req.query["q"] : "";
    if (q.trim().length < 2) {
      res.json({ instruments: [] });
      return;
    }

    const marketParam = req.query["market"];
    if (typeof marketParam === "string" && !isMarketCode(marketParam)) {
      res.status(400).json({ error: "Unknown market" });
      return;
    }
    const market = typeof marketParam === "string" ? marketParam : undefined;

    try {
      const instruments = await searchInstruments(q, market);
      res.json({ instruments });
    } catch {
      res.status(500).json({ error: "Instrument search failed" });
    }
  }),
);
