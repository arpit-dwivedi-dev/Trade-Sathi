import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Injectable, PLATFORM_ID, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { AuthService } from './auth.service';

/** Matches the API's once-a-minute last_active_at stamp (last-active.service.ts). */
const HEARTBEAT_MS = 60 * 1000;

/**
 * Keeps a signed-in user "online" in the Admin panel while a tab is open.
 *
 * The API only learns someone is around when they make a request, so an open
 * but idle tab looked like an absent user. This pings GET /api/me once a
 * minute — only while the tab is visible, so a background tab doesn't count
 * as presence — and requireAuth stamps last_active_at from it.
 */
@Injectable({ providedIn: 'root' })
export class PresenceService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly document = inject(DOCUMENT);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly onVisibility = () => {
    if (this.document.visibilityState === 'visible') void this.ping();
  };

  start(): void {
    if (!this.isBrowser || this.timer) return;
    this.timer = setInterval(() => this.onVisibility(), HEARTBEAT_MS);
    // Coming back to the tab counts straight away rather than up to a minute later.
    this.document.addEventListener('visibilitychange', this.onVisibility);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.document.removeEventListener('visibilitychange', this.onVisibility);
  }

  private async ping(): Promise<void> {
    try {
      const token = await this.auth.getAccessToken();
      if (!token) return;
      await firstValueFrom(this.http.get('/api/me', { headers: { Authorization: `Bearer ${token}` } }));
    } catch {
      // Presence is best-effort; a missed beat just means one stale minute.
    }
  }
}
