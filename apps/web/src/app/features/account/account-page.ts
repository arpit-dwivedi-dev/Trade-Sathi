import { DatePipe } from '@angular/common';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import type { ProfileDetails, SessionGeo, SurveyAnswers, SurveyStatus } from '@chartanalyzer/shared';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { CheckboxModule } from 'primeng/checkbox';
import { ChipModule } from 'primeng/chip';
import { InputTextModule } from 'primeng/inputtext';
import { Select } from 'primeng/select';

import type { ChangeData } from 'ngx-intl-tel-input-gg';
import { CountryISO, NgxIntlTelInputModule, SearchCountryField } from 'ngx-intl-tel-input-gg';

import { AuthService } from '../../core/auth.service';
import { ProfileService } from './profile.service';

/** Multi-choice answers are stored as one ", "-joined string — see SurveyQuestion in packages/shared. */
const MULTI_CHOICE_SEPARATOR = ', ';

function splitMultiChoice(value: string | undefined): string[] {
  return (value ?? '')
    .split(MULTI_CHOICE_SEPARATOR)
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/**
 * Identity, editable profile details, and the onboarding survey. Billing —
 * plans, usage, credits — still lives on the Billing tab; this tab has no
 * credit surface of its own. The survey grants no credit (see
 * 20260916120000_survey_no_credit.sql) — it exists purely to tailor the
 * product to how the user trades.
 */
@Component({
  selector: 'app-account-page',
  imports: [
    RouterLink,
    DatePipe,
    FormsModule,
    ButtonModule,
    CardModule,
    CheckboxModule,
    ChipModule,
    InputTextModule,
    NgxIntlTelInputModule,
    Select,
  ],
  styleUrl: './account-page.css',
  templateUrl: './account-page.html',
})
export class AccountPage implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly profileService = inject(ProfileService);

  protected readonly user = this.auth.user;

  /** Supabase stamps this on the auth user; absent on a session shape without it. */
  protected readonly memberSince = computed(() => this.user()?.created_at ?? null);

  protected readonly profile = signal<ProfileDetails | null>(null);
  protected readonly fullName = signal('');
  /**
   * The Profile card's heading: the saved name, falling back to the address
   * for a profile with no name yet. Reads the service's shared value rather
   * than the editable fullName above, which would follow every keystroke.
   */
  protected readonly whoName = computed(
    () => this.profileService.cachedName()?.trim() || this.user()?.email || '',
  );
  /** Under the heading: the address, or the sign-in method when that is the heading. */
  protected readonly whoSub = computed(() =>
    this.profileService.cachedName()?.trim() ? (this.user()?.email ?? '') : 'Signed in with email',
  );
  protected readonly phoneNumber = signal('');
  protected readonly CountryISO = CountryISO;
  protected readonly SearchCountryField = SearchCountryField;
  protected readonly phonePreferredCountries = [CountryISO.India, CountryISO.UnitedStates, CountryISO.UnitedKingdom];
  protected readonly profession = signal('');
  protected readonly location = signal('');
  protected readonly savingProfile = signal(false);
  protected readonly profileError = signal<string | null>(null);
  protected readonly profileSaved = signal(false);

  protected readonly sessionGeo = signal<SessionGeo | null>(null);
  /**
   * geoip returns an ISO 3166-1 alpha-2 code ("IN"); Intl.DisplayNames turns
   * that into the name a user recognizes ("India") without a data dependency.
   * Falls back to the raw code if the runtime can't resolve it.
   */
  protected readonly sessionCountryName = computed(() => {
    const code = this.sessionGeo()?.country;
    if (!code) return null;
    try {
      return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
    } catch {
      return code;
    }
  });
  protected readonly sessionLocationLabel = computed(() => {
    const geo = this.sessionGeo();
    if (!geo) return null;
    const country = this.sessionCountryName();
    if (!country) return null;
    return geo.city ? `${geo.city}, ${country}` : country;
  });

  protected readonly surveyStatus = signal<SurveyStatus | null>(null);
  protected readonly surveyLoading = signal(true);
  protected readonly surveyAnswers = signal<SurveyAnswers>({});
  protected readonly submittingSurvey = signal(false);
  protected readonly surveyError = signal<string | null>(null);
  /** Whether the most recent submission left no further survey pending — the
   * "you're all caught up" card. No credit is granted any more; this only
   * tracks completion. */
  protected readonly surveyJustCompleted = signal(false);

  ngOnInit(): void {
    void this.loadProfile();
    void this.loadSurvey();
    void this.loadSessionGeo();
  }

  private async loadSessionGeo(): Promise<void> {
    this.sessionGeo.set(await this.profileService.getSessionGeo());
  }

  private async loadProfile(): Promise<void> {
    const details = await this.profileService.getProfile();
    this.profile.set(details);
    this.fullName.set(details?.fullName ?? '');
    this.phoneNumber.set(details?.phoneNumber ?? '');
    this.profession.set(details?.profession ?? '');
    this.location.set(details?.location ?? '');
  }

  private async loadSurvey(): Promise<void> {
    this.surveyLoading.set(true);
    const status = await this.profileService.getSurveyStatus();
    this.surveyStatus.set(status);
    this.surveyAnswers.set({});
    this.surveyLoading.set(false);
  }

  protected setAnswer(questionId: string, value: string): void {
    this.surveyAnswers.update((answers) => ({ ...answers, [questionId]: value }));
  }

  /**
   * SurveyAnswers is typed as Record<string, string>, but an unanswered
   * question genuinely has no entry — indexing it is `undefined` at runtime
   * despite what the type says. Going through this method (rather than
   * `surveyAnswers()[id]` in the template) is what keeps that `undefined`
   * from reaching `[ngModel]`: on a <select> an undefined value leaves every
   * <option> unselected, including the "Choose one…" placeholder, so the
   * control rendered visibly blank instead of showing it.
   */
  protected answerFor(questionId: string): string {
    return this.surveyAnswers()[questionId] ?? '';
  }

  protected selectedOptions(questionId: string): string[] {
    return splitMultiChoice(this.surveyAnswers()[questionId]);
  }

  protected isSelected(questionId: string, option: string): boolean {
    return this.selectedOptions(questionId).includes(option);
  }

  protected toggleOption(questionId: string, option: string): void {
    const current = this.selectedOptions(questionId);
    const next = current.includes(option)
      ? current.filter((o) => o !== option)
      : [...current, option];
    this.setAnswer(questionId, next.join(MULTI_CHOICE_SEPARATOR));
  }

  protected readonly surveyComplete = computed(() => {
    const survey = this.surveyStatus()?.survey;
    if (!survey) return false;
    const answers = this.surveyAnswers();
    return survey.questions.every((q) => (answers[q.id] ?? '').trim().length > 0);
  });

  /**
   * The phone input reports a parsed `ChangeData` object (or `null` when
   * cleared) rather than a plain string — E.164 is what's stored and sent to
   * the backend, since it's unambiguous regardless of which country's flag
   * was selected.
   */
  protected onPhoneChange(data: ChangeData | null): void {
    this.phoneNumber.set(data?.e164Number ?? '');
    this.profileSaved.set(false);
  }

  protected async saveProfile(): Promise<void> {
    const trimmedName = this.fullName().trim();
    if (!trimmedName) {
      this.profileError.set('Please enter a name.');
      return;
    }

    this.savingProfile.set(true);
    this.profileError.set(null);
    this.profileSaved.set(false);

    const updates = {
      fullName: trimmedName,
      phoneNumber: this.phoneNumber().trim(),
      profession: this.profession().trim(),
      location: this.location().trim(),
    };
    const result = await this.profileService.updateProfile(updates);
    this.savingProfile.set(false);

    if (result.ok) {
      this.profile.update((p) => (p ? { ...p, ...updates } : p));
      this.profileSaved.set(true);
    } else {
      this.profileError.set(result.message);
    }
  }

  protected async submitSurvey(): Promise<void> {
    const survey = this.surveyStatus()?.survey;
    if (!survey || !this.surveyComplete()) return;

    this.submittingSurvey.set(true);
    this.surveyError.set(null);

    const result = await this.profileService.submitSurvey(survey.id, this.surveyAnswers());
    this.submittingSurvey.set(false);

    if (!result.ok) {
      this.surveyError.set(result.message);
      return;
    }

    if (result.outcome === 'applied') {
      this.surveyJustCompleted.set(true);
    }

    // Re-fetch: a new survey may already be waiting, or this really was the
    // last one — either way the backend, not local state, decides what's next.
    await this.loadSurvey();
  }

  protected async signOut(): Promise<void> {
    await this.auth.signOut();
    await this.router.navigateByUrl('/login');
  }
}
