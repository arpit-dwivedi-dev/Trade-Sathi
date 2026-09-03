import { DatePipe } from '@angular/common';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { Router, RouterLink } from '@angular/router';
import type { ProfileDetails, SurveyAnswers, SurveyStatus } from '@chartanalyzer/shared';

import { NavRail } from '../../shared/nav-rail/nav-rail';
import { AuthService } from '../../core/auth.service';
import { ThemeService } from '../../core/theme.service';
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
 * plans, usage, credits — still lives on the Billing tab; this page only adds
 * the credit balance as a small readout so completing the survey has a
 * visible payoff right where it happened.
 */
@Component({
  selector: 'app-account-page',
  imports: [
    RouterLink,
    DatePipe,
    FormsModule,
    MatButtonModule,
    MatCardModule,
    MatCheckboxModule,
    MatChipsModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
    NavRail,
  ],
  styleUrl: './account-page.css',
  templateUrl: './account-page.html',
})
export class AccountPage implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly themeService = inject(ThemeService);
  private readonly profileService = inject(ProfileService);

  protected readonly user = this.auth.user;
  protected readonly theme = this.themeService.theme;
  /** Drawer state. Only consulted below 900px, where the rail is off-canvas. */
  protected readonly navOpen = signal(false);
  /** The rail's desktop icons-only state — see NavRail.collapsed. */
  protected readonly navCollapsed = signal(false);

  /** Supabase stamps this on the auth user; absent on a session shape without it. */
  protected readonly memberSince = computed(() => this.user()?.created_at ?? null);

  protected readonly profile = signal<ProfileDetails | null>(null);
  protected readonly fullName = signal('');
  protected readonly phoneNumber = signal('');
  protected readonly profession = signal('');
  protected readonly location = signal('');
  protected readonly savingProfile = signal(false);
  protected readonly profileError = signal<string | null>(null);
  protected readonly profileSaved = signal(false);

  protected readonly surveyStatus = signal<SurveyStatus | null>(null);
  protected readonly surveyLoading = signal(true);
  protected readonly surveyAnswers = signal<SurveyAnswers>({});
  protected readonly submittingSurvey = signal(false);
  protected readonly surveyError = signal<string | null>(null);
  protected readonly surveyJustEarnedCredit = signal(false);

  ngOnInit(): void {
    void this.loadProfile();
    void this.loadSurvey();
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
      this.surveyJustEarnedCredit.set(true);
      this.profile.update((p) => (p ? { ...p, creditBalance: p.creditBalance + 1 } : p));
    }

    // Re-fetch: a new survey may already be waiting, or this really was the
    // last one — either way the backend, not local state, decides what's next.
    await this.loadSurvey();
  }

  protected toggleNav(): void {
    this.navOpen.update((open) => !open);
  }

  protected closeNav(): void {
    this.navOpen.set(false);
  }

  protected toggleTheme(): void {
    this.themeService.toggle();
  }

  protected async signOut(): Promise<void> {
    await this.auth.signOut();
    await this.router.navigateByUrl('/login');
  }
}
