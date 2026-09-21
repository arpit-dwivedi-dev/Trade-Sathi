import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { AuthService } from './auth.service';

/**
 * Whether the signed-in user is an admin, as GET /api/me reports it.
 *
 * This only decides what the web app *shows* — the Admin nav row and the
 * adminGuard. It is not a security boundary: every /api/admin/* request is
 * authorized again server-side by requireAdmin, so a tampered flag here only
 * reveals an empty screen.
 */
@Injectable({ providedIn: 'root' })
export class AdminAccessService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);

  private readonly state = signal(false);
  readonly isAdmin = this.state.asReadonly();

  /** The user the cached answer belongs to, so a sign-in as someone else re-asks. */
  private checkedFor: string | null = null;
  private request: Promise<boolean> | null = null;

  /** Resolves the flag once per signed-in user; concurrent callers share one request. */
  async ensure(): Promise<boolean> {
    const userId = this.auth.user()?.id ?? null;
    if (!userId) {
      this.state.set(false);
      return false;
    }
    if (this.checkedFor === userId && !this.request) return this.state();

    this.request ??= this.fetch().then((isAdmin) => {
      this.state.set(isAdmin);
      this.checkedFor = userId;
      this.request = null;
      return isAdmin;
    });
    return this.request;
  }

  private async fetch(): Promise<boolean> {
    try {
      const token = await this.auth.getAccessToken();
      if (!token) return false;
      const me = await firstValueFrom(
        this.http.get<{ isAdmin?: boolean }>('/api/me', {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      return me.isAdmin === true;
    } catch {
      return false;
    }
  }
}
