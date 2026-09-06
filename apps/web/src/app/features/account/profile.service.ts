import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type {
  ProfileDetails,
  ProfileUpdatePayload,
  SessionGeo,
  SurveyAnswers,
  SurveyStatus,
  SurveySubmitOutcome,
} from '@chartanalyzer/shared';

import { AuthService } from '../../core/auth.service';

export type { ProfileDetails };

export type ActionResult = { ok: true } | { ok: false; message: string };
export type SubmitSurveyResult =
  | { ok: true; outcome: SurveySubmitOutcome }
  | { ok: false; message: string };

const NOT_SIGNED_IN: ActionResult = { ok: false, message: 'You are not signed in.' };

/** Talks to /api/me/profile and /api/survey — the Account page's profile+survey editing surface. */
@Injectable({ providedIn: 'root' })
export class ProfileService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);

  private async authHeaders(): Promise<{ Authorization: string } | null> {
    const token = await this.auth.getAccessToken();
    return token ? { Authorization: `Bearer ${token}` } : null;
  }

  /**
   * The saved name, shared by every screen that labels the signed-in person
   * (the nav rail, from both the app shell and Account). Root-scoped and
   * filled by the first getProfile() of the session, so navigating between
   * those screens reuses the name instead of showing the email fallback
   * again while a fresh read is in flight.
   */
  readonly cachedName = signal<string | null>(null);
  private nameLoad: Promise<void> | null = null;

  async getProfile(): Promise<ProfileDetails | null> {
    const headers = await this.authHeaders();
    if (!headers) return null;
    try {
      const details = await firstValueFrom(
        this.http.get<ProfileDetails>('/api/me/profile', { headers }),
      );
      this.cachedName.set(details.fullName);
      return details;
    } catch (cause) {
      console.warn('failed to load profile', cause);
      return null;
    }
  }

  /** Fills cachedName once per session. Callers that only need the label use this. */
  async ensureName(): Promise<void> {
    this.nameLoad ??= this.getProfile().then(() => undefined);
    return this.nameLoad;
  }

  async updateProfile(updates: ProfileUpdatePayload): Promise<ActionResult> {
    const headers = await this.authHeaders();
    if (!headers) return NOT_SIGNED_IN;
    try {
      await firstValueFrom(this.http.patch('/api/me/profile', updates, { headers }));
      if (updates.fullName !== undefined) this.cachedName.set(updates.fullName);
      return { ok: true };
    } catch (cause) {
      const status = cause instanceof HttpErrorResponse ? cause.status : 0;
      return {
        ok: false,
        message:
          status === 400
            ? 'Please check the highlighted fields and try again.'
            : "Couldn't save your details. Please try again.",
      };
    }
  }

  /** The region GET /api/me resolved from the caller's IP on this request. */
  async getSessionGeo(): Promise<SessionGeo | null> {
    const headers = await this.authHeaders();
    if (!headers) return null;
    try {
      const response = await firstValueFrom(
        this.http.get<{ geo: SessionGeo | null }>('/api/me', { headers }),
      );
      return response.geo;
    } catch (cause) {
      console.warn('failed to load session geo', cause);
      return null;
    }
  }

  async getSurveyStatus(): Promise<SurveyStatus | null> {
    const headers = await this.authHeaders();
    if (!headers) return null;
    try {
      return await firstValueFrom(this.http.get<SurveyStatus>('/api/survey', { headers }));
    } catch (cause) {
      console.warn('failed to load survey status', cause);
      return null;
    }
  }

  async submitSurvey(surveyId: string, answers: SurveyAnswers): Promise<SubmitSurveyResult> {
    const headers = await this.authHeaders();
    if (!headers) return { ok: false, message: 'You are not signed in.' };
    try {
      const response = await firstValueFrom(
        this.http.post<{ outcome: SurveySubmitOutcome }>(
          `/api/survey/${surveyId}/responses`,
          { answers },
          { headers },
        ),
      );
      return { ok: true, outcome: response.outcome };
    } catch (cause) {
      const status = cause instanceof HttpErrorResponse ? cause.status : 0;
      return {
        ok: false,
        message:
          status === 400
            ? 'Please answer every question before submitting.'
            : "Couldn't submit the survey. Please try again.",
      };
    }
  }
}
