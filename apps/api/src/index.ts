import { createServer } from "node:http";
import express from "express";
import { env } from "./lib/env.js";
import { logger } from "./lib/logger.js";
import { startDailyBriefingScheduler } from "./jobs/daily-briefing.job.js";
import { startStrandedAnalysisSweeper } from "./jobs/stranded-analyses.job.js";
import { startStrandedWatchlistRunSweeper } from "./jobs/stranded-watchlist-runs.job.js";
import { startStrandedDailyBriefingSweeper } from "./jobs/stranded-daily-briefings.job.js";
import { analysesRouter } from "./routes/analyses.route.js";
import { billingRouter } from "./routes/billing.route.js";
import { healthRouter } from "./routes/health.route.js";
import { instrumentsRouter } from "./routes/instruments.route.js";
import { warmInstrumentCache } from "./services/instruments.service.js";
import { internalRouter } from "./routes/internal.route.js";
import { attachMarketStream } from "./routes/market-stream.route.js";
import { marketRouter } from "./routes/market.route.js";
import { meRouter } from "./routes/me.route.js";
import { pricingRouter } from "./routes/pricing.route.js";
import { surveyRouter } from "./routes/survey.route.js";
import { dailyBriefingRouter } from "./routes/daily-briefing.route.js";
import { webhooksRouter } from "./routes/webhooks.route.js";
import { resolveGeo } from "./middleware/geo.js";

const app = express();

// Needed for resolveGeo to read the real client IP from X-Forwarded-For
// rather than the load balancer's address, when the API sits behind one.
app.set("trust proxy", true);

// Mounted BEFORE the global JSON parser. The Razorpay webhook route verifies
// its signature over the exact received bytes, so it brings its own
// express.raw() scoped to its own path; express.json() must never have parsed
// that path first. Every route below still gets normal JSON parsing.
app.use(webhooksRouter);

app.use(express.json());
app.use((req, res, next) => {
  resolveGeo(req, res, next).catch(next);
});
app.use(healthRouter);
app.use(meRouter);
app.use(pricingRouter);
app.use(analysesRouter);
app.use(billingRouter);
app.use(instrumentsRouter);
app.use(internalRouter);
app.use(marketRouter);
app.use(surveyRouter);
app.use(dailyBriefingRouter);

// An explicit http.Server rather than app.listen(): the live market stream
// needs the underlying server to hook WebSocket upgrades onto.
const server = createServer(app);
attachMarketStream(server);

// listen()'s callback only runs on success, so a failure to bind — a port
// already in use, most often — surfaces here or nowhere. Left unhandled it is
// an EADDRINUSE thrown out of the event loop, which reads as an unexplained
// stack trace rather than the one-line configuration problem it is.
server.on("error", (cause: NodeJS.ErrnoException) => {
  if (cause.code === "EADDRINUSE") {
    logger.error(`port ${env.port} is already in use`, {
      hint: "another instance of the API is probably already running",
    });
  } else {
    logger.error("the api server failed to start", { cause: String(cause) });
  }
  process.exit(1);
});

server.listen(env.port, () => {
  logger.info(`api listening on port ${env.port}`);
  // Not awaited: the server should accept requests immediately, and every
  // search already waits on the same shared load if one is still in flight.
  void warmInstrumentCache();
});

// Requires the API process to stay running continuously — see the top-of-file
// comment in jobs/daily-briefing.job.ts for the documented limitation.
startDailyBriefingScheduler();

// Recovers analyses stranded at 'queued' by a restart — the counterpart to the
// fire-and-forget dispatch in routes/analyses.route.ts.
startStrandedAnalysisSweeper();

// Recovers "Analyze Now" watchlist runs stranded at 'processing' by a
// restart — the counterpart to the fire-and-forget dispatch in
// runWatchlistItemNow (daily-briefing.service.ts).
startStrandedWatchlistRunSweeper();

// Recovers scheduled briefing logs stranded at 'processing' by a restart.
startStrandedDailyBriefingSweeper();
