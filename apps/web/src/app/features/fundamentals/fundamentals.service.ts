import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { InstrumentFundamentals } from '@tradesathi/shared';
import { AuthService } from '../../core/auth.service';
import { startRowWatch, type RowWatch } from '../../core/row-watch';
import { SupabaseClientService } from '../../core/supabase-client';
import type { AnalysisRow } from '../analyze/analysis.types';

export type FundamentalsResult =
  | { ok: true; fundamentals: InstrumentFundamentals }
  | { ok: false; message: string };

export type AnalyzeWithAiResult =
  | { ok: true; id: string }
  | {
      ok: false;
      reason: 'insufficient_credits' | 'not_found' | 'unauthenticated' | 'error';
      message: string;
    };

export type FundamentalsPollOutcome =
  | { outcome: 'complete'; row: AnalysisRow }
  | { outcome: 'failed'; row: AnalysisRow }
  | { outcome: 'timed_out' }
  | { outcome: 'poll_error' };

export interface FundamentalsPollHandle {
  result: Promise<FundamentalsPollOutcome>;
  cancel: () => void;
}

// Same budget as AnalyzeService.pollAnalysis, and for the same reason: the
// pipeline is a single model call measured at 35-54s, so this outlasts the
// work rather than pre-empting it.
const POLL_TIMEOUT_MS = 180_000;
const MAX_CONSECUTIVE_POLL_FAILURES = 3;

/**
 * The one backend call the Fundamentals tab makes. Proxied through the API for
 * the same reasons the candle read is (see LiveService): the upstream provider
 * is server-side only, and the shared TTL cache in front of it lives there.
 */
@Injectable({ providedIn: 'root' })
export class FundamentalsService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly supabase = inject(SupabaseClientService);

  async fetchFundamentals(instrumentId: string): Promise<FundamentalsResult> {
    const token = await this.auth.getAccessToken();
    if (!token) return { ok: false, message: 'You are not signed in.' };

    try {
      const fundamentals = await firstValueFrom(
        this.http.get<InstrumentFundamentals>('/api/market/fundamentals', {
          params: { instrumentId },
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      return { ok: true, fundamentals };
    } catch (cause) {
      const status = cause instanceof HttpErrorResponse ? cause.status : 0;
      if (status === 404) {
        return { ok: false, message: 'No fundamental data is published for this symbol.' };
      }
      if (status === 502) {
        return { ok: false, message: 'Fundamental data is unavailable right now. Try again shortly.' };
      }
      if (status === 401) {
        return { ok: false, message: 'Your session expired. Please sign in again.' };
      }
      return { ok: false, message: 'Could not load fundamentals. Please try again.' };
    }
  }

  /**
   * Starts the "Analyze with AI" pipeline for one instrument. POSTs JSON, not
   * multipart — unlike the chart-upload flow there is no image involved.
   */
  async analyzeWithAi(instrumentId: string): Promise<AnalyzeWithAiResult> {
    const token = await this.auth.getAccessToken();
    if (!token) {
      return { ok: false, reason: 'unauthenticated', message: 'You are not signed in.' };
    }

    try {
      const response = await firstValueFrom(
        this.http.post<{ analysisId: string }>(
          '/api/market/fundamentals/analyze',
          { instrumentId },
          { headers: { Authorization: `Bearer ${token}` } },
        ),
      );
      return { ok: true, id: response.analysisId };
    } catch (cause) {
      const status = cause instanceof HttpErrorResponse ? cause.status : 0;

      if (status === 402) {
        return {
          ok: false,
          reason: 'insufficient_credits',
          message: "You don't have enough credits for a fundamentals analysis.",
        };
      }
      if (status === 404) {
        return { ok: false, reason: 'not_found', message: 'Instrument not found.' };
      }
      return { ok: false, reason: 'error', message: 'Something went wrong. Please try again.' };
    }
  }

  /**
   * Watches one analyses row through the browser Supabase client — RLS
   * already permits reading your own rows, so no backend endpoint is needed.
   * A near-identical port of AnalyzeService.pollAnalysis: same startRowWatch
   * Realtime-backed cadence, same timeout and failure policy. No
   * analysis_patterns fetch here — a fundamentals row never writes patterns.
   */
  pollFundamentalsAnalysis(
    id: string,
    onUpdate: (row: AnalysisRow) => void,
  ): FundamentalsPollHandle {
    const client = this.supabase.client;

    let watch: RowWatch | null = null;
    let settled = false;
    let consecutiveFailures = 0;
    const startedAt = Date.now();

    const result = new Promise<FundamentalsPollOutcome>((resolve) => {
      const stop = (): void => {
        watch?.stop();
        watch = null;
      };

      const finish = (outcome: FundamentalsPollOutcome): void => {
        if (settled) return;
        settled = true;
        stop();
        resolve(outcome);
      };

      if (!client) {
        finish({ outcome: 'poll_error' });
        return;
      }

      const tick = async (): Promise<void> => {
        if (settled) return;

        if (Date.now() - startedAt >= POLL_TIMEOUT_MS) {
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
            finish({ outcome: 'complete', row: data });
            return;
          }

          if (data.status === 'failed') {
            finish({ outcome: 'failed', row: data });
          }
        } catch (cause) {
          consecutiveFailures += 1;
          console.warn('fundamentals analysis poll attempt failed', cause);

          if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
            finish({ outcome: 'poll_error' });
          }
        }
      };

      watch = startRowWatch(client, `fundamentals-analysis-${id}`, 'analyses', `id=eq.${id}`, () => {
        void tick();
      });
    });

    return {
      result,
      cancel: () => {
        settled = true;
        watch?.stop();
        watch = null;
      },
    };
  }
}
