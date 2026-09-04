import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { InstrumentFundamentals } from '@chartanalyzer/shared';
import { AuthService } from '../../core/auth.service';

export type FundamentalsResult =
  | { ok: true; fundamentals: InstrumentFundamentals }
  | { ok: false; message: string };

/**
 * The one backend call the Fundamentals tab makes. Proxied through the API for
 * the same reasons the candle read is (see LiveService): the upstream provider
 * is server-side only, and the shared TTL cache in front of it lives there.
 */
@Injectable({ providedIn: 'root' })
export class FundamentalsService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);

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
      return { ok: false, message: 'Could not load fundamentals. Please try again.' };
    }
  }
}
