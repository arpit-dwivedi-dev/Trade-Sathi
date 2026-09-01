import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { AuthService } from '../../core/auth.service';
import type { LiveCandle } from '../../shared/live-chart/live-chart';

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
  | { ok: true; analysisId: string }
  | { ok: false; reason: 'quota_exceeded' | 'error'; message: string };

/**
 * Backend calls for the live chart view.
 *
 * Candles and the analyze trigger go through the API: the market-data provider
 * is server-side only, and starting an analysis spends quota. Watching the
 * resulting row is NOT here — it is AnalyzeService.pollAnalysis, which already
 * watches an analyses row by id and is now shared by both flows rather than
 * reimplemented per feature.
 */
@Injectable({ providedIn: 'root' })
export class LiveService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);

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
   * is the id of the 'queued' analyses row it will fill in — watch that row
   * with AnalyzeService.pollAnalysis, which reports its 'failed' status too.
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
        this.http.post<{ analysisId: string }>('/api/market/analyze', form, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      return { ok: true, analysisId: accepted.analysisId };
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

}
