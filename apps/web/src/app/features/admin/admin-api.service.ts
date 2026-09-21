import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type {
  AdminActivity,
  AdminEconomics,
  AdminHealth,
  AdminOverview,
  AdminPage,
  AdminPayments,
  AdminRange,
  AdminUserDetail,
  AdminUserRow,
} from '@tradesathi/shared';

import { AuthService } from '../../core/auth.service';

type Query = Record<string, string | number | null | undefined>;

/** Talks to apps/api's read-only /api/admin/* endpoints. */
@Injectable({ providedIn: 'root' })
export class AdminApiService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);

  overview(range: AdminRange): Promise<AdminOverview> {
    return this.get('/api/admin/overview', { range });
  }

  economics(query: Query): Promise<AdminEconomics> {
    return this.get('/api/admin/economics', query);
  }

  payments(query: Query): Promise<AdminPayments> {
    return this.get('/api/admin/payments', query);
  }

  users(query: Query): Promise<AdminPage<AdminUserRow>> {
    return this.get('/api/admin/users', query);
  }

  user(id: string): Promise<AdminUserDetail> {
    return this.get(`/api/admin/users/${encodeURIComponent(id)}`, {});
  }

  activity(range: AdminRange): Promise<AdminActivity> {
    return this.get('/api/admin/activity', { range });
  }

  health(query: Query): Promise<AdminHealth> {
    return this.get('/api/admin/health', query);
  }

  private async get<T>(url: string, query: Query): Promise<T> {
    const token = await this.auth.getAccessToken();
    if (!token) throw new Error('You are not signed in.');

    let params = new HttpParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== null && value !== undefined && value !== '') {
        params = params.set(key, String(value));
      }
    }
    return firstValueFrom(
      this.http.get<T>(url, { params, headers: { Authorization: `Bearer ${token}` } }),
    );
  }
}

/** A readable message for a failed admin request. */
export function adminErrorMessage(cause: unknown): string {
  const body = (cause as { error?: { error?: unknown } } | null)?.error;
  return typeof body?.error === 'string' ? body.error : 'Something went wrong loading this section.';
}
