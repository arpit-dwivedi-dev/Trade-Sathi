import { createHash, randomUUID } from "node:crypto";
import { logger } from "../lib/logger.js";
import { supabaseAdmin } from "../lib/supabase.js";

const BUCKET = "chart-images";

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export type CreateAnalysisResult =
  | { ok: true; id: string; status: "queued" }
  | { ok: false; reason: "quota_exceeded" };

/** The current UTC year-month, in the same 'YYYY-MM' shape that
 *  check_and_increment_usage computes internally via
 *  to_char(now() at time zone 'UTC', 'YYYY-MM'). */
function currentUtcPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}

/**
 * Reverses one unit of a previously granted quota increment.
 *
 * A single guarded atomic UPDATE — the `analyses_used > 0` guard means it can
 * never drive the counter negative, and it targets exactly the period string
 * captured before the RPC ran, never a freshly recomputed "current" period.
 */
async function decrementUsage(profileId: string, period: string): Promise<void> {
  const { error } = await supabaseAdmin.rpc("decrement_usage", {
    p_profile_id: profileId,
    p_period: period,
  });
  if (error) {
    throw error;
  }
}

/**
 * Creates a queued analysis: consumes quota, stores the image, writes the row.
 *
 * createAnalysis() trusts that its caller (the route) has already validated
 * file size and allowed MIME type before invoking it — it does not re-run
 * HTTP-level upload validation itself. This is an intentional boundary (route
 * owns HTTP validation, service owns business logic), not an oversight. Do not
 * call this function with an unvalidated file.
 *
 * Expected outcomes are returned as a discriminated result; only genuinely
 * unexpected failures (storage/DB errors) throw, and the route maps those to 500.
 */
export async function createAnalysis(
  profileId: string,
  file: { buffer: Buffer; mimetype: string },
  sourceType: "paste" | "upload",
): Promise<CreateAnalysisResult> {
  // Captured ONCE, before the RPC, and reused verbatim by every compensating
  // decrement below — see the trade-off notes at the upload failure branch.
  const periodForCompensation = currentUtcPeriod();

  // (a) Atomic quota gate. Everything after this point has consumed one unit.
  const { data: withinQuota, error: quotaError } = await supabaseAdmin.rpc(
    "check_and_increment_usage",
    { p_profile_id: profileId },
  );
  if (quotaError) {
    throw quotaError;
  }
  if (withinQuota !== true) {
    return { ok: false, reason: "quota_exceeded" };
  }

  // (b) For future dedupe/caching. Nothing reads it yet.
  const imageHash = createHash("sha256").update(file.buffer).digest("hex");

  // (c) The bucket's RLS read policy requires the first path segment to be the
  // owning profile id.
  const ext = EXTENSION_BY_MIME[file.mimetype] ?? "bin";
  const imageKey = `${profileId}/${randomUUID()}.${ext}`;

  // (d) Store the bytes.
  const { error: uploadError } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(imageKey, file.buffer, { contentType: file.mimetype });

  if (uploadError) {
    // Quota was already consumed by the RPC, but no analysis exists — give the
    // unit back rather than charging the user for a failed upload.
    //
    // Known, accepted MVP trade-offs of compensating rather than doing this in
    // one transaction:
    //
    // (1) Between the RPC's increment and this decrement, a concurrent request
    //     for the same user near their quota limit could see a temporary false
    //     quota_exceeded that would have succeeded moments later. This cannot
    //     corrupt the counter — the decrement is a single guarded atomic UPDATE
    //     — it is purely an availability edge case, accepted for MVP.
    //
    // (2) If this compensating decrement itself fails (network/DB error), the
    //     user permanently loses one unit of quota for a failed upload. Also
    //     accepted for MVP.
    //
    // (3) periodForCompensation is captured once in Node before the RPC call
    //     specifically to narrow — not eliminate — a UTC month-boundary race.
    //     If a request straddles midnight UTC on the last day of the month (or
    //     app/DB server clocks skew), the RPC's own internal now() could land in
    //     a different month than this captured value, so the decrement targets
    //     the wrong period and this unit never gets refunded. Same failure
    //     category as (2), just a different trigger — it does not corrupt the
    //     counter table. Fully closing this requires changing
    //     check_and_increment_usage's return contract to report back the exact
    //     period it operated on, which is a migration change out of scope here;
    //     accepted as a known MVP limitation.
    await decrementUsage(profileId, periodForCompensation);
    throw uploadError;
  }

  // (e) Record the queued analysis.
  //
  // model_id and prompt_version are 'unassigned' placeholders: a future task's
  // AI-processing job overwrites them with the real values once it actually
  // dispatches the model call. They exist only to satisfy the NOT NULL
  // constraint before that happens.
  const { data: inserted, error: insertError } = await supabaseAdmin
    .from("analyses")
    .insert({
      profile_id: profileId,
      source_type: sourceType,
      image_key: imageKey,
      image_hash: imageHash,
      model_id: "unassigned",
      prompt_version: "unassigned",
      status: "queued",
    })
    .select("id")
    .single();

  if (insertError || !inserted) {
    // Best-effort cleanup of the now-orphaned object. A cleanup failure must
    // not mask the original insert error, so it is only logged.
    const { error: removeError } = await supabaseAdmin.storage
      .from(BUCKET)
      .remove([imageKey]);
    if (removeError) {
      logger.error("failed to clean up orphaned chart image", {
        imageKey,
        cause: String(removeError),
      });
    }
    // Same compensating decrement, same captured period, same trade-offs as (d).
    await decrementUsage(profileId, periodForCompensation);
    throw insertError ?? new Error("Analysis insert returned no row");
  }

  return { ok: true, id: inserted.id, status: "queued" };
}
