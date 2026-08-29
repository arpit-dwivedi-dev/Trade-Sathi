import express from "express";
import { env } from "./lib/env.js";
import { logger } from "./lib/logger.js";
import { healthRouter } from "./routes/health.route.js";

const app = express();

app.use(express.json());
app.use(healthRouter);

app.listen(env.port, () => {
  logger.info(`api listening on port ${env.port}`);
});
