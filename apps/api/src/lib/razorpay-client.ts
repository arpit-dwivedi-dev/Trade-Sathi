import Razorpay from "razorpay";
import { env } from "./env.js";

/**
 * The Razorpay API client.
 *
 * Configuration only — no business logic belongs in this module. The secret key
 * lives here and must never leave this process: it is used to sign API calls,
 * and is never returned to a client, logged, or included in an error message.
 */
export const razorpay = new Razorpay({
  key_id: env.razorpayKeyId,
  key_secret: env.razorpayKeySecret,
});
