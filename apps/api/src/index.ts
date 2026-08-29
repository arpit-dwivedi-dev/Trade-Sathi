import express from "express";
import { env } from "./lib/env.js";
import { logger } from "./lib/logger.js";
import { analysesRouter } from "./routes/analyses.route.js";
import { healthRouter } from "./routes/health.route.js";
import { meRouter } from "./routes/me.route.js";

const app = express();

app.use(express.json());
app.use(healthRouter);
app.use(meRouter);
app.use(analysesRouter);

app.listen(env.port, () => {
  logger.info(`api listening on port ${env.port}`);
});
