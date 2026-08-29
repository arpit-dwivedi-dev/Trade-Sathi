import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { AuthService } from '../../core/auth.service';
import { SupabaseClientService } from '../../core/supabase-client';
import type { AnalysisPattern, AnalysisRow } from './analysis.types';
import type { SourceType } from './chart-drop';

/** Longest edge of the compressed image, in pixels. */
const MAX_EDGE_PX = 1024;
const JPEG_QUALITY = 0.8;

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 90_000;
/** Consecutive query failures (~6s of continuous failure) before giving up. */
const MAX_CONSECUTIVE_POLL_FAILURES = 3;

export type SubmitResult =
  | { ok: true; id: string }
  | {
      ok: false;
      reason: 'quota_exceeded' | 'invalid' | 'unauthenticated' | 'error';
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
            blob ? resolve(blob) : reject(new Error('Failed to encode the image'));
          },
          'image/jpeg',
          JPEG_QUALITY,
        );
      });
    } finally {
      bitmap.close();
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
          reason: 'quota_exceeded',
          message: "You've used all your analyses this month.",
        };
      }
      if (status === 400) {
        return { ok: false, reason: 'invalid', message: 'That image could not be accepted.' };
      }
      return { ok: false, reason: 'error', message: 'Something went wrong. Please try again.' };
    }
  }

  /**
   * Polls the analyses row directly through the browser Supabase client — RLS
   * already permits reading your own rows, so no backend endpoint is needed.
   *
   * Returns a cancel() alongside the promise because a bare Promise cannot be
   * cancelled from outside, and the page must stop polling on destroy.
   */
  pollAnalysis(id: string, onUpdate: (row: AnalysisRow) => void): PollHandle {
    const client = this.supabase.client;

    let timer: ReturnType<typeof setInterval> | null = null;
    let settled = false;
    let consecutiveFailures = 0;
    const startedAt = Date.now();

    const result = new Promise<PollOutcome>((resolve) => {
      const stop = (): void => {
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
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

      timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
      void tick();
    });

    return {
      result,
      cancel: () => {
        // Called from ngOnDestroy: the caller has already stopped caring, so the
        // promise is simply left unresolved rather than given a special outcome.
        settled = true;
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      },
    };
  }
}
