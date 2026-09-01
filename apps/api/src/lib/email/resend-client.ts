import { Resend } from "resend";
import { env } from "../env.js";

/**
 * Thin Resend wrapper — no business logic, matching how ai-client.ts and
 * razorpay-client.ts hold their respective SDK clients.
 */
export const resendClient = new Resend(env.resendApiKey);

export interface EmailAttachment {
  filename: string;
  content: Buffer;
}

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  attachments?: EmailAttachment[];
}

export async function sendEmail(params: SendEmailParams): Promise<void> {
  const { error } = await resendClient.emails.send({
    from: env.resendFromAddress,
    to: params.to,
    subject: params.subject,
    html: params.html,
    // Omitted entirely when there is nothing to attach: Resend treats an empty
    // array as a malformed attachments field rather than as "no attachments".
    ...(params.attachments?.length ? { attachments: params.attachments } : {}),
  });
  if (error) {
    throw new Error(`Resend send failed: ${error.message}`);
  }
}
