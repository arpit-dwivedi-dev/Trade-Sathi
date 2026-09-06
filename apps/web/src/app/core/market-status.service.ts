import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { MarketStatus } from '@chartanalyzer/shared';
import { AuthService } from './auth.service';

/**
 * The one backend call the top bar's market-status badge makes. Proxied
 * through the API for the same reason candles/fundamentals are (see
 * FundamentalsService): the upstream NSE read and its cache live server-side.
 */
@Injectable({ providedIn: 'root' })
export class MarketStatusService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);

  async fetchStatus(market: 'NSE' | 'NASDAQ'): Promise<MarketStatus | null> {
    const token = await this.auth.getAccessToken();
    if (!token) return null;

    try {
      return await firstValueFrom(
        this.http.get<MarketStatus>('/api/market/status', {
          params: { market },
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
    } catch {
      return null;
    }
  }
}
