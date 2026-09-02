import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type {
  ProfileDetails,
  ProfileUpdatePayload,
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

  async getProfile(): Promise<ProfileDetails | null> {
    const headers = await this.authHeaders();
    if (!headers) return null;
    try {
      return await firstValueFrom(this.http.get<ProfileDetails>('/api/me/profile', { headers }));
    } catch (cause) {
      console.warn('failed to load profile', cause);
      return null;
    }
  }

  async updateProfile(updates: ProfileUpdatePayload): Promise<ActionResult> {
    const headers = await this.authHeaders();
    if (!headers) return NOT_SIGNED_IN;
    try {
      await firstValueFrom(this.http.patch('/api/me/profile', updates, { headers }));
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
