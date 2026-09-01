import type { NextFunction, Request, RequestHandler, Response } from "express";
import { logger } from "./logger.js";

/**
 * Adapts an async Express handler so a rejection can never escape it.
 *
 * Express 4 does not await a handler's return value: a promise that rejects is
 * not routed to an error handler, it becomes an unhandled rejection — which
 * Node terminates the process on by default. For an API documented to run as
 * exactly one instance (see the operational constraints in CLAUDE.md), that is
 * a total outage triggered by one unexpected throw on one request.
 *
 * Every handler in this codebase already try/catches its own body, so this
 * changes no behaviour today. It exists so that safety is enforced by the type
 * system at the mount point rather than by every future handler remembering to
 * wrap itself — the failure mode of forgetting is the whole process, not the
 * one request.
 *
 * The fallback response deliberately says nothing specific: reaching it means a
 * path the handler did not anticipate, so there is no meaningful detail to give
 * and no reason to leak internals guessing.
 */
export function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch((cause: unknown) => {
      logger.error("unhandled error in route handler", {
        method: req.method,
        path: req.path,
        cause: String(cause),
      });
      // Headers are already sent when the handler failed after responding —
      // writing again would throw here, inside the very catch meant to contain
      // the failure.
      if (res.headersSent) return;
      res.status(500).json({ error: "Something went wrong" });
    });
  };
}
