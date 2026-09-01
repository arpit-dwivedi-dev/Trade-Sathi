import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { AuthService } from '../../core/auth.service';
import { SupabaseClientService } from '../../core/supabase-client';
import type { AnalysisPattern, AnalysisRow } from '../analyze/analysis.types';
import type { LiveCandle } from '../../shared/live-chart/live-chart';

const POLL_INTERVAL_MS = 2000;
/* The pipeline is market data + a model call over up to 250 candles, measured
 * at ~55s end to end on a one-day intraday window. Three minutes leaves real
 * headroom over that without leaving a user staring at a spinner forever. */
const POLL_TIMEOUT_MS = 180_000;
/** Consecutive query failures (~6s of continuous failure) before giving up. */
const MAX_CONSECUTIVE_POLL_FAILURES = 3;

export interface CandleWindowResponse {
  instrument: { id: string; symbol: string; name: string; exchange: string };
  timeframeLabel: string;
  /** Length of one candle in minutes — see CandleWindow on the API side. */
  intervalMinutes: number;
  marketDataDate: string | null;
  candles: LiveCandle[];
}

export type CandlesResult =
  | { ok: true; window: CandleWindowResponse }
  | { ok: false; message: string };

export type StartAnalysisResult =
  | { ok: true; startedAt: string }
  | { ok: false; reason: 'quota_exceeded' | 'error'; message: string };

export type LiveAnalysisOutcome =
  | { outcome: 'complete'; row: AnalysisRow; patterns: AnalysisPattern[] }
  | { outcome: 'timed_out' }
  | { outcome: 'poll_error' };

export interface LiveAnalysisHandle {
  result: Promise<LiveAnalysisOutcome>;
  cancel: () => void;
}

/**
 * Backend calls for the live chart view.
 *
 * Candles and the analyze trigger go through the API (the market-data provider
 * is server-side only, and analysis spends quota); reading the finished
 * analysis row goes straight to Supabase under RLS, the same read-your-own-data
 * path AnalyzeService.pollAnalysis uses.
 */
@Injectable({ providedIn: 'root' })
export class LiveService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly supabase = inject(SupabaseClientService);

  async fetchCandles(instrumentId: string, lookbackDays: number): Promise<CandlesResult> {
    const token = await this.auth.getAccessToken();
    if (!token) return { ok: false, message: 'You are not signed in.' };

    try {
      const window = await firstValueFrom(
        this.http.get<CandleWindowResponse>('/api/market/candles', {
          params: { instrumentId, lookbackDays: String(lookbackDays) },
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      return { ok: true, window };
    } catch (cause) {
      const status = cause instanceof HttpErrorResponse ? cause.status : 0;
      if (status === 502 || status === 404) {
        return { ok: false, message: 'Market data is unavailable for this symbol right now.' };
      }
      return { ok: false, message: 'Could not load chart data. Please try again.' };
    }
  }

  /**
   * Starts a live analysis. The API responds as soon as its fast checks pass
   * (202) and runs the 20-30s pipeline in the background, so what comes back
   * is a start time, not a result — see awaitAnalysis.
   *
   * `chart` is the PNG this browser rendered from the same candles. It is
   * stored with the analysis so the user can see and download the chart they
   * were actually looking at; the model reads the candle data itself, not this
   * image. Null means the capture failed and the API renders its own — the
   * analysis is unaffected either way.
   *
   * Sent as multipart, and deliberately without an explicit Content-Type: the
   * browser has to set it itself so the multipart boundary matches the body.
   */
  async startAnalysis(
    instrumentId: string,
    lookbackDays: number,
    chart: Blob | null,
  ): Promise<StartAnalysisResult> {
    const token = await this.auth.getAccessToken();
    if (!token) return { ok: false, reason: 'error', message: 'You are not signed in.' };

    const form = new FormData();
    form.append('instrumentId', instrumentId);
    form.append('lookbackDays', String(lookbackDays));
    if (chart) form.append('image', chart, 'chart.png');

    try {
      const accepted = await firstValueFrom(
        this.http.post<{ startedAt: string }>('/api/market/analyze', form, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      return { ok: true, startedAt: accepted.startedAt };
    } catch (cause) {
      const status = cause instanceof HttpErrorResponse ? cause.status : 0;
      if (status === 402) {
        return {
          ok: false,
          reason: 'quota_exceeded',
          message: "You've used all your analyses this month.",
        };
      }
      return { ok: false, reason: 'error', message: 'Could not start the analysis. Try again.' };
    }
  }

  /**
   * Waits for the row the background pipeline writes: the newest source='live'
   * analysis for this instrument created at or after the run's start time.
   * Identifying it by (instrument, source, time) rather than by id is what
   * lets the API answer immediately instead of holding the request open for
   * the whole pipeline.
   *
   * The pipeline only ever inserts already-complete rows, so there is no
   * queued/processing state to observe here — a failed run simply never
   * produces a row and this times out.
   */
  awaitAnalysis(instrumentId: string, startedAt: string): LiveAnalysisHandle {
    const client = this.supabase.client;

    let timer: ReturnType<typeof setInterval> | null = null;
    let settled = false;
    let consecutiveFailures = 0;
    const beganAt = Date.now();

    const result = new Promise<LiveAnalysisOutcome>((resolve) => {
      const finish = (outcome: LiveAnalysisOutcome): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
        resolve(outcome);
      };

      if (!client) {
        // SSR has no Supabase client; nothing can be polled.
        finish({ outcome: 'poll_error' });
        return;
      }

      const tick = async (): Promise<void> => {
        if (settled) return;

        if (Date.now() - beganAt >= POLL_TIMEOUT_MS) {
          finish({ outcome: 'timed_out' });
          return;
        }

        try {
          const { data, error } = await client
            .from('analyses')
            .select('*')
            .eq('instrument_id', instrumentId)
            .eq('source', 'live')
            .gte('created_at', startedAt)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle<AnalysisRow>();

          if (error) throw error;

          consecutiveFailures = 0;
          if (!data || settled) return;

          const { data: patterns, error: patternsError } = await client
            .from('analysis_patterns')
            .select('*')
            .eq('analysis_id', data.id)
            .returns<AnalysisPattern[]>();

          if (patternsError) throw patternsError;
          finish({ outcome: 'complete', row: data, patterns: patterns ?? [] });
        } catch (cause) {
          // A read error here is a frontend problem (network, client config),
          // not the pipeline failing. One blip waits for the next poll; only
          // sustained failure gives up.
          consecutiveFailures += 1;
          console.warn('live analysis poll attempt failed', cause);
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
        settled = true;
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      },
    };
  }
}
