import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { startRowWatch, type RowWatch } from '../../core/row-watch';
import { AuthService } from '../../core/auth.service';
import { SupabaseClientService } from '../../core/supabase-client';
import type { AnalysisPattern, AnalysisRow } from './analysis.types';
import type { SourceType } from './chart-drop';

/** Longest edge of the compressed image, in pixels. */
const MAX_EDGE_PX = 1024;
const JPEG_QUALITY = 0.8;

/* Matches the live view's budget, and for the same reason: the pipeline is a
 * single model call whose wall-clock time was measured across repeat runs at
 * 35-54s, so 90s left as little as half a minute of headroom and reported
 * 'timed out' on an analysis that was still running and would have completed.
 * The backend gives up on its own at 120s per attempt (see lib/ai-client.ts),
 * so this now outlasts the work rather than pre-empting it. */
const POLL_TIMEOUT_MS = 180_000;
/**
 * How far back findUnfinishedAnalysis will look. Past the pipeline's own
 * budget, so anything older is stranded rather than running.
 */
const UNFINISHED_LOOKBACK_MS = 10 * 60_000;
/** Consecutive query failures (~6s of continuous failure) before giving up. */
const MAX_CONSECUTIVE_POLL_FAILURES = 3;

export type SubmitResult =
  | { ok: true; id: string }
  | {
      ok: false;
      reason: 'insufficient_credits' | 'invalid' | 'unauthenticated' | 'error';
      message: string;
    };

export type PollOutcome =
  | { outcome: 'complete'; row: AnalysisRow; patterns: AnalysisPattern[] }
  | { outcome: 'failed'; row: AnalysisRow }
  | { outcome: 'timed_out' }
  | { outcome: 'poll_error' };

export interface PollHandle {
  result: Promise<PollOutcome>;
  cancel: () => void;
}

@Injectable({ providedIn: 'root' })
export class AnalyzeService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly supabase = inject(SupabaseClientService);

  /**
   * Downscale to a max 1024px longer edge and re-encode as JPEG.
   *
   * Always re-encodes regardless of input format: png/webp are both accepted
   * upstream, and normalizing to one format keeps the payload predictable. This
   * is a real cost lever, not just an upload-speed one — the AI provider bills
   * per image by pixel count.
   */
  async compressImage(file: File): Promise<Blob> {
    // Canvas, createImageBitmap and Blob do not exist during SSR. In practice
    // this only ever runs from a browser-only interaction (paste/drop/pick), so
    // this guard should never fire; it exists to fail loudly rather than hit an
    // undefined global if a future change calls it from the server.
    if (!this.supabase.isBrowser) {
      throw new Error('compressImage is browser-only and cannot run during SSR');
    }

    const bitmap = await createImageBitmap(file);
    try {
      // Never upscale: a smaller image keeps its own dimensions.
      const scale = Math.min(1, MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Could not get a 2D canvas context');
      ctx.drawImage(bitmap, 0, 0, width, height);

      return await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (blob) => {
            if (blob) {
              resolve(blob);
              return;
            }
            reject(new Error('Failed to encode the image'));
          },
          'image/jpeg',
          JPEG_QUALITY,
        );
      });
    } finally {
      bitmap.close();
    }
  }

  /**
   * Reads the one credit balance straight from Supabase, the same way
   * pollAnalysis reads analyses — the profiles select-own policy already
   * permits this, so no backend endpoint is needed.
   *
   * Returns null if it can't be determined (SSR, no session, read error): the
   * caller must not treat "unknown" as "zero" and block a usable account.
   */
  async fetchCreditBalance(): Promise<number | null> {
    const client = this.supabase.client;
    if (!client) return null;

    const profileId = this.auth.user()?.id;
    if (!profileId) return null;

    try {
      const { data, error } = await client
        .from('profiles')
        .select('credit_balance')
        .eq('id', profileId)
        .single<{ credit_balance: number }>();

      if (error) throw error;
      return data?.credit_balance ?? 0;
    } catch (cause) {
      console.warn('credit balance lookup failed', cause);
      return null;
    }
  }

  /**
   * The newest still-running analysis for one instrument, or null.
   *
   * Read straight from Supabase like every other analyses read here — RLS
   * limits it to this user's own rows. The workspace and the Fundamentals tab
   * use it after a reload to re-attach to a run whose id they never got to
   * remember: the row is created server-side before the POST that started it
   * has even returned, so a refresh in that window leaves a charged run with
   * nothing pointing at it.
   *
   * `source` narrows it to the caller's own flow — both screens can be running
   * on the same instrument at once, and neither may adopt the other's run.
   *
   * Bounded by age so a row left stranded by a dead API instance (the
   * stranded-analysis sweeper owns those) can't keep a chart busy forever.
   */
  async findUnfinishedAnalysis(
    instrumentId: string,
    source: AnalysisRow['source'],
  ): Promise<AnalysisRow | null> {
    const client = this.supabase.client;
    if (!client) return null;

    const since = new Date(Date.now() - UNFINISHED_LOOKBACK_MS).toISOString();

    try {
      const { data, error } = await client
        .from('analyses')
        .select('*')
        .eq('instrument_id', instrumentId)
        .eq('source', source)
        .in('status', ['queued', 'processing'])
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(1)
        .returns<AnalysisRow[]>();

      if (error) throw error;
      return data?.[0] ?? null;
    } catch (cause) {
      console.warn('unfinished analysis lookup failed', cause);
      return null;
    }
  }

  /** POSTs the compressed image to the backend, mapping status codes to reasons. */
  async submitAnalysis(blob: Blob, sourceType: SourceType): Promise<SubmitResult> {
    const token = await this.auth.getAccessToken();
    if (!token) {
      return { ok: false, reason: 'unauthenticated', message: 'You are not signed in.' };
    }

    const form = new FormData();
    form.append('image', blob, 'chart.jpg');
    form.append('sourceType', sourceType);

    try {
      // No Content-Type header here on purpose: the browser must set it itself
      // so the multipart boundary is present, or multer cannot parse the body.
      const response = await firstValueFrom(
        this.http.post<{ id: string }>('/api/analyses', form, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      return { ok: true, id: response.id };
    } catch (cause) {
      const status = cause instanceof HttpErrorResponse ? cause.status : 0;

      if (status === 402) {
        return {
          ok: false,
          reason: 'insufficient_credits',
          message: "You don't have enough credits for this analysis.",
        };
      }
      if (status === 400) {
        return { ok: false, reason: 'invalid', message: 'That image could not be accepted.' };
      }
      return { ok: false, reason: 'error', message: 'Something went wrong. Please try again.' };
    }
  }

  /**
   * Watches the analyses row directly through the browser Supabase client — RLS
   * already permits reading your own rows, so no backend endpoint is needed.
   *
   * startRowWatch decides when to re-read: a Realtime subscription on this
   * row, backed by a timer that carries the load on its own if the socket never
   * comes up. The reading, the timeout and the failure policy below are
   * unchanged from when this was a bare 2-second poll.
   *
   * Returns a cancel() alongside the promise because a bare Promise cannot be
   * cancelled from outside, and the page must stop watching on destroy.
   */
  pollAnalysis(id: string, onUpdate: (row: AnalysisRow) => void): PollHandle {
    const client = this.supabase.client;

    let watch: RowWatch | null = null;
    let settled = false;
    let consecutiveFailures = 0;
    const startedAt = Date.now();

    const result = new Promise<PollOutcome>((resolve) => {
      const stop = (): void => {
        watch?.stop();
        watch = null;
      };

      // Every exit path clears the interval first: an interval still firing
      // after resolution is a bug.
      const finish = (outcome: PollOutcome): void => {
        if (settled) return;
        settled = true;
        stop();
        resolve(outcome);
      };

      if (!client) {
        // SSR has no Supabase client; nothing can be polled.
        finish({ outcome: 'poll_error' });
        return;
      }

      const tick = async (): Promise<void> => {
        if (settled) return;

        if (Date.now() - startedAt >= POLL_TIMEOUT_MS) {
          // Distinct from 'failed': the backend may still be working, and the
          // row can complete later. We just stop waiting on it here.
          finish({ outcome: 'timed_out' });
          return;
        }

        try {
          const { data, error } = await client
            .from('analyses')
            .select('*')
            .eq('id', id)
            .single<AnalysisRow>();

          if (error || !data) throw error ?? new Error('Analysis row not found');

          consecutiveFailures = 0;
          if (settled) return;
          onUpdate(data);

          if (data.status === 'complete') {
            const { data: patterns, error: patternsError } = await client
              .from('analysis_patterns')
              .select('*')
              .eq('analysis_id', id)
              .returns<AnalysisPattern[]>();

            if (patternsError) throw patternsError;
            finish({ outcome: 'complete', row: data, patterns: patterns ?? [] });
            return;
          }

          if (data.status === 'failed') {
            finish({ outcome: 'failed', row: data });
          }
        } catch (cause) {
          // A read error here is a *frontend* problem (network, client config),
          // not the analysis pipeline failing — reporting it as 'failed' would
          // lie to the user. One blip just waits for the next scheduled poll,
          // which doubles as the retry; only sustained failure gives up.
          consecutiveFailures += 1;
          console.warn('analysis poll attempt failed', cause);

          if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
            finish({ outcome: 'poll_error' });
          }
        }
      };

      watch = startRowWatch(client, `analysis-${id}`, 'analyses', `id=eq.${id}`, () => {
        void tick();
      });
    });

    return {
      result,
      cancel: () => {
        // Called from ngOnDestroy: the caller has already stopped caring, so the
        // promise is simply left unresolved rather than given a special outcome.
        settled = true;
        watch?.stop();
        watch = null;
      },
    };
  }
}
