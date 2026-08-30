import express from "express";
import { env } from "./lib/env.js";
import { logger } from "./lib/logger.js";
import { analysesRouter } from "./routes/analyses.route.js";
import { billingRouter } from "./routes/billing.route.js";
import { healthRouter } from "./routes/health.route.js";
import { meRouter } from "./routes/me.route.js";
import { webhooksRouter } from "./routes/webhooks.route.js";

const app = express();

// Mounted BEFORE the global JSON parser. The Razorpay webhook route verifies
// its signature over the exact received bytes, so it brings its own
// express.raw() scoped to its own path; express.json() must never have parsed
// that path first. Every route below still gets normal JSON parsing.
app.use(webhooksRouter);

app.use(express.json());
app.use(healthRouter);
app.use(meRouter);
app.use(analysesRouter);
app.use(billingRouter);

app.listen(env.port, () => {
  logger.info(`api listening on port ${env.port}`);
});
