import type { NextFunction, Request, Response } from "express";
import geoip from "geoip-lite";
import type { SessionGeo } from "@chartanalyzer/shared";
import { logger } from "../lib/logger.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by resolveGeo from the caller's IP. Null when lookup fails (e.g. localhost, private IP). */
      geo?: SessionGeo | null;
    }
  }
}

/**
 * express behind a proxy/load balancer reports the client's real IP in
 * X-Forwarded-For (first entry) once `app.set("trust proxy", ...)` is
 * configured; req.ip falls back to the socket address otherwise.
 */
function clientIp(req: Request): string {
  const forwarded = req.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.ip ?? req.socket.remoteAddress ?? "";
}

/**
 * geoip-lite's offline database only covers public IPs — loopback/private
 * addresses (127.0.0.1, ::1, 10.x, 192.168.x, ...), which is what every
 * request looks like from a local dev server, never resolve. This is what
 * every local developer's request looks like, so a dev fallback is worth it.
 */
function isPrivateOrLoopbackIp(ip: string): boolean {
  const bare = ip.replace(/^::ffff:/, "");
  if (bare === "::1" || bare === "127.0.0.1") return true;
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(bare);
}

interface IpApiResponse {
  status: "success" | "fail";
  country?: string;
  countryCode?: string;
  regionName?: string;
  city?: string;
  timezone?: string;
}

/**
 * Dev-only fallback for the private/loopback case above: asks ip-api.com
 * (free, no API key) to geolocate this machine's own outbound public IP.
 * Never called in production — there the caller's IP is always the real
 * public address forwarded by the proxy, so geoip-lite alone is enough and
 * no outbound call belongs on the request path.
 */
async function lookupOwnPublicIpGeo(): Promise<SessionGeo | null> {
  try {
    const res = await fetch("http://ip-api.com/json/?fields=status,country,countryCode,regionName,city,timezone");
    const data = (await res.json()) as IpApiResponse;
    if (data.status !== "success") return null;
    return {
      ip: "own-public-ip",
      country: data.countryCode ?? null,
      region: data.regionName ?? null,
      city: data.city ?? null,
      timezone: data.timezone ?? null,
    };
  } catch (cause) {
    logger.error("dev geo fallback lookup failed", { cause: String(cause) });
    return null;
  }
}

/**
 * Resolves the caller's region from their IP using geoip-lite's bundled,
 * offline MaxMind-derived database — no outbound call, no third-party
 * dependency on the request path. Attaches the result to req.geo so
 * downstream handlers (e.g. news relevance, default market) can read it
 * without redoing the lookup.
 */
export async function resolveGeo(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const ip = clientIp(req);
  const lookup = geoip.lookup(ip);

  if (lookup) {
    req.geo = {
      ip,
      country: lookup.country ?? null,
      region: lookup.region ?? null,
      city: lookup.city ?? null,
      timezone: lookup.timezone ?? null,
    };
    next();
    return;
  }

  if (process.env["NODE_ENV"] !== "production" && isPrivateOrLoopbackIp(ip)) {
    req.geo = (await lookupOwnPublicIpGeo()) ?? { ip, country: null, region: null, city: null, timezone: null };
    next();
    return;
  }

  req.geo = { ip, country: null, region: null, city: null, timezone: null };
  next();
}
