import { createServer } from "node:http";
import express from "express";
import { env } from "./lib/env.js";
import { logger } from "./lib/logger.js";
import { startDailyBriefingScheduler } from "./jobs/daily-briefing.job.js";
import { analysesRouter } from "./routes/analyses.route.js";
import { billingRouter } from "./routes/billing.route.js";
import { healthRouter } from "./routes/health.route.js";
import { instrumentsRouter } from "./routes/instruments.route.js";
import { internalRouter } from "./routes/internal.route.js";
import { attachMarketStream } from "./routes/market-stream.route.js";
import { marketRouter } from "./routes/market.route.js";
import { meRouter } from "./routes/me.route.js";
import { watchlistRouter } from "./routes/watchlist.route.js";
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
app.use(instrumentsRouter);
app.use(internalRouter);
app.use(marketRouter);
app.use(watchlistRouter);

// An explicit http.Server rather than app.listen(): the live market stream
// needs the underlying server to hook WebSocket upgrades onto.
const server = createServer(app);
attachMarketStream(server);

server.listen(env.port, () => {
  logger.info(`api listening on port ${env.port}`);
});

// Requires the API process to stay running continuously — see the top-of-file
// comment in jobs/daily-briefing.job.ts for the documented limitation.
startDailyBriefingScheduler();
