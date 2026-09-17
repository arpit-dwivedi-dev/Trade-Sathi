import type { FeatureCreditKey } from "@chartanalyzer/shared";
import { createHash, randomUUID } from "node:crypto";
import { logger } from "../lib/logger.js";
import { callRpc, supabaseAdmin } from "../lib/supabase.js";

const BUCKET = "chart-images";

const FEATURE_KEY: FeatureCreditKey = "chart_analysis";

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/**
 * `status: "complete"` means this request was answered from a previous
 * analysis of the byte-identical image (see findCachedAnalysis) — no upload,
 * no model call, no credit spent. The caller must NOT dispatch
 * processAnalysis for it; the row it names is already finished.
 */
export type CreateAnalysisResult =
  | { ok: true; id: string; status: "queued" | "complete" }
  | { ok: false; reason: "insufficient_credits" };

/**
 * Spends one chart_analysis credit via the shared consume_credits RPC.
 * Returns whether the balance had enough to cover it — the same feature key
 * and cost that live-analysis.service.ts's "analyze this chart" path spends,
 * since both are the same user-initiated, one-off analysis for billing
 * purposes.
 */
export async function consumeAnalysisCredit(profileId: string): Promise<boolean> {
  const outcome = await callRpc<"consumed" | "insufficient_credits">("consume_credits", {
    p_profile_id: profileId,
    p_feature_key: FEATURE_KEY,
  });
  return outcome === "consumed";
}

/**
 * Gives back a previously consumed chart_analysis credit — called when
 * consume_credits succeeded but the work it paid for never produced a usable
 * result (a failed upload, a failed pipeline run). `analysisId` is passed
 * when the row it refunds against already exists at the time of the failure;
 * omit it when nothing was ever durably stored.
 */
export async function refundAnalysisCredit(
  profileId: string,
  analysisId?: string | null,
): Promise<void> {
  await callRpc<null>("refund_credits", {
    p_profile_id: profileId,
    p_feature_key: FEATURE_KEY,
    p_ref_analysis_id: analysisId ?? null,
  });
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
/**
 * The most recent completed analysis this profile already has of these exact
 * image bytes, or null.
 *
 * Deliberately scoped to one profile even though the hash is global: another
 * user's analysis of the same chart is their data, and serving it here would
 * hand out a row this user cannot read under RLS anyway. The cost of that
 * choice is a duplicate model call the first time each user submits a widely
 * shared screenshot, which is the right trade.
 *
 * Only 'complete' rows qualify. A 'queued' row is a run still in flight (or
 * one stranded by a restart, which the sweeper in jobs/stranded-analyses.job
 * will fail), and a 'failed' row is exactly the case that SHOULD get a fresh
 * attempt rather than being handed its own failure back forever.
 *
 * A lookup error returns null rather than throwing: a cache miss costs a model
 * call, while a thrown error would fail an analysis the user can legitimately
 * pay for.
 */
async function findCachedAnalysis(
  profileId: string,
  imageHash: string,
): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("analyses")
    .select("id")
    // analyses_image_hash_created_at_idx covers the hash and the ordering;
    // profile_id and status are filters on the handful of rows that survive it.
    .eq("image_hash", imageHash)
    .eq("profile_id", profileId)
    .eq("status", "complete")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string }>();

  if (error) {
    logger.error("cached analysis lookup failed", {
      profileId,
      cause: String(error),
    });
    return null;
  }

  return data?.id ?? null;
}

export async function createAnalysis(
  profileId: string,
  file: { buffer: Buffer; mimetype: string },
  sourceType: "paste" | "upload",
): Promise<CreateAnalysisResult> {
  // (a) Content address of the image, computed before anything is spent —
  // re-submitting the same screenshot must not cost a quota unit or a model
  // call to discover it is the same screenshot.
  const imageHash = createHash("sha256").update(file.buffer).digest("hex");

  const cachedId = await findCachedAnalysis(profileId, imageHash);
  if (cachedId) {
    logger.info("analysis served from cache", { profileId, analysisId: cachedId });
    return { ok: true, id: cachedId, status: "complete" };
  }

  // (b) Atomic credit gate. Everything after this point has consumed one
  // chart_analysis credit.
  const consumed = await consumeAnalysisCredit(profileId);
  if (!consumed) {
    return { ok: false, reason: "insufficient_credits" };
  }

  // (c) The bucket's RLS read policy requires the first path segment to be the
  // owning profile id.
  const ext = EXTENSION_BY_MIME[file.mimetype] ?? "bin";
  const imageKey = `${profileId}/${randomUUID()}.${ext}`;

  // (d) Store the bytes.
  const { error: uploadError } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(imageKey, file.buffer, { contentType: file.mimetype });

  if (uploadError) {
    // The credit was already consumed by the RPC, but no analysis exists —
    // give it back rather than charging the user for a failed upload.
    //
    // Known, accepted MVP trade-off of compensating rather than doing this in
    // one transaction: if this refund itself fails (network/DB error), the
    // user permanently loses one credit for a failed upload.
    await refundAnalysisCredit(profileId);
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
    .single<{ id: string }>();

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
    // Same compensating refund, same trade-off as (d).
    await refundAnalysisCredit(profileId);
    throw insertError ?? new Error("Analysis insert returned no row");
  }

  return { ok: true, id: inserted.id, status: "queued" };
}
