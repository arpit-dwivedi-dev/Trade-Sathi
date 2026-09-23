import { DatePipe, isPlatformBrowser } from '@angular/common';
import { Component, PLATFORM_ID, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import type { ProfileDetails, SessionGeo, SurveyAnswers, SurveyStatus } from '@tradesathi/shared';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { CheckboxModule } from 'primeng/checkbox';
import { ChipModule } from 'primeng/chip';
import { InputTextModule } from 'primeng/inputtext';
import { Select } from 'primeng/select';

import type { ItiUtils } from 'intl-tel-input';
import allCountries from 'intl-tel-input/data';

import { environment } from '../../../environments/environment';
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


/** Dial codes the user is most likely to want, pinned above the A-Z list. */
const PREFERRED_COUNTRY_ISOS = ['in', 'us', 'gb'];

/** ITU-T E.164 caps a full international number (dial code included) at 15 digits. */
const E164_MAX_DIGITS = 15;

export interface PhoneCountryOption {
  /** ISO 3166-1 alpha-2, lowercase — the value carried by the country picker. */
  iso2: string;
  /** Country calling code without the leading "+". */
  dialCode: string;
  name: string;
  /** Upper-case ISO code — what the closed picker shows, where a name won't fit. */
  isoLabel: string;
  /**
   * What the picker's filter matches on. The dial code and ISO code are in
   * here but not in `name`, so typing "+91" or "IN" finds India without the
   * closed picker repeating a code the field next to it already shows.
   */
  search: string;
}

/**
 * intl-tel-input ships the dial codes but leaves `name` blank (it fills those
 * from a locale bundle at widget init, which we no longer run). Intl.DisplayNames
 * gives us the same English names without a second data dependency; the few
 * codes it can't resolve (e.g. "ac", "ta") fall back to the raw ISO code.
 */
function buildPhoneCountries(): PhoneCountryOption[] {
  let display: Intl.DisplayNames | null = null;
  try {
    display = new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    display = null;
  }

  const options: PhoneCountryOption[] = allCountries.map((country) => {
    const name = display?.of(country.iso2.toUpperCase()) ?? country.iso2.toUpperCase();
    return {
      iso2: country.iso2,
      dialCode: country.dialCode,
      name,
      isoLabel: country.iso2.toUpperCase(),
      search: `${name} +${country.dialCode} ${country.iso2}`,
    };
  });

  options.sort((a, b) => a.name.localeCompare(b.name, 'en'));

  const preferred = PREFERRED_COUNTRY_ISOS.map((iso) =>
    options.find((o) => o.iso2 === iso),
  ).filter((o): o is PhoneCountryOption => o !== undefined);

  return [...preferred, ...options.filter((o) => !PREFERRED_COUNTRY_ISOS.includes(o.iso2))];
}

/**
 * Splits a stored E.164 number back into the country + national parts the two
 * controls need. Longest dial code wins (so "+1264" resolves to Anguilla, not
 * the US), and among countries sharing a dial code the one whose area codes
 * match — else the lowest `priority`, which is how intl-tel-input ranks them.
 */
function splitE164(e164: string): { iso2: string; national: string } | null {
  const digits = e164.replace(/\D/g, '');
  if (!digits) return null;

  const matches = allCountries.filter((c) => digits.startsWith(c.dialCode));
  if (matches.length === 0) return null;

  const longest = Math.max(...matches.map((c) => c.dialCode.length));
  const candidates = matches.filter((c) => c.dialCode.length === longest);
  const national = digits.slice(longest);

  const byArea = candidates.find((c) => c.areaCodes?.some((a) => national.startsWith(a)));
  const chosen = byArea ?? [...candidates].sort((a, b) => a.priority - b.priority)[0];

  return { iso2: chosen.iso2, national };
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
    Select,
  ],
  styleUrl: './account-page.css',
  templateUrl: './account-page.html',
})
export class AccountPage implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly profileService = inject(ProfileService);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

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

  /**
   * The phone number is edited as three controls — country picker, read-only
   * dial code, national digits — but stored as one E.164 string. The country
   * is the only way to set the dial code; that box is never typed into.
   */
  protected readonly phoneCountries = buildPhoneCountries();
  protected readonly phoneCountryIso = signal('in');
  protected readonly phoneNational = signal('');
  protected readonly phoneDialCode = computed(
    () => this.phoneCountries.find((c) => c.iso2 === this.phoneCountryIso())?.dialCode ?? '',
  );
  /** Empty national digits mean "no phone number", not a bare dial code. */
  protected readonly phoneNumber = computed(() => {
    const national = this.phoneNational();
    return national ? `+${this.phoneDialCode()}${national}` : '';
  });

  /**
   * The dial code eats into E.164's 15-digit ceiling, so the room left for the
   * national part depends on which country is selected.
   */
  protected readonly phoneNationalMaxLength = computed(
    () => E164_MAX_DIGITS - this.phoneDialCode().length,
  );

  /**
   * libphonenumber's rules, lazy-loaded: the bundle is ~260KB, far too much to
   * pay on first paint for one optional field, and it's useless during SSR
   * where nobody is typing. Until it lands, `phoneError` falls back to a
   * length check, so the field is never blocked waiting on the download.
   */
  private readonly phoneUtils = signal<ItiUtils | null>(null);

  /**
   * intl-tel-input's global stylesheet (see angular.json `styles`) carries the
   * flag sprite and a `.iti__<iso2>` rule per country picking that country's
   * frame out of it. We render the same two classes by hand rather than
   * shipping a second copy of that table.
   */
  protected flagClass(iso2: string): string {
    return `iti__flag iti__${iso2}`;
  }

  /**
   * The message under the field, or null when there's nothing to say. Blank is
   * valid — the phone number is optional — so an untouched field never shouts.
   */
  protected readonly phoneError = computed<string | null>(() => {
    const national = this.phoneNational();
    if (!national) return null;

    const utils = this.phoneUtils();
    if (!utils) {
      // Pre-load fallback: E.164's own bounds, the most any check can assume
      // without per-country rules.
      const total = this.phoneDialCode().length + national.length;
      return national.length < 4 || total > E164_MAX_DIGITS
        ? 'Enter a valid phone number.'
        : null;
    }

    const iso2 = this.phoneCountryIso();
    const country = this.phoneCountries.find((c) => c.iso2 === iso2)?.name ?? 'this country';

    switch (utils.getValidationError(this.phoneNumber(), iso2)) {
      case 'TOO_SHORT':
        return `That number is too short for ${country}.`;
      case 'TOO_LONG':
        return `That number is too long for ${country}.`;
      case 'INVALID_COUNTRY_CODE':
        return 'Pick a country for this number.';
      case null:
      case 'IS_POSSIBLE':
        /*
         * The length fits, so now check the digits themselves. `isValidNumber`
         * is not enough here: it only asks whether the length is plausible, so
         * an Indian mobile left behind after switching the country to the UK
         * ("+449876543210") passes it. `isValidNumberPrecise` matches the
         * country's actual number ranges and rejects it — which is the whole
         * point of tying validation to the selected country.
         */
        return utils.isValidNumberPrecise(this.phoneNumber(), iso2)
          ? null
          : `That doesn't look like a ${country} number.`;
      default:
        return `That doesn't look like a ${country} number.`;
    }
  });
  protected readonly phoneInvalid = computed(() => this.phoneError() !== null);

  /**
   * An example mobile number for the chosen country, so the expected length is
   * obvious before the user gets an error. Taken from the E.164 example and
   * reduced to its core digits — the NATIONAL format would show the national
   * trunk prefix ("081234 56789" for India), which is exactly the digit this
   * field must not contain.
   */
  protected readonly phonePlaceholder = computed(() => {
    const utils = this.phoneUtils();
    if (!utils) return 'Phone number';
    const iso2 = this.phoneCountryIso();
    try {
      return utils.getCoreNumber(utils.getExampleNumber(iso2, 'MOBILE', 'E164'), iso2) || 'Phone number';
    } catch {
      return 'Phone number';
    }
  });

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

  /**
   * The survey is hidden in production builds for now, and not fetched there
   * either. Development builds (`ng serve`, environment.development.ts) keep
   * it, so it can still be worked on locally.
   */
  protected readonly showSurvey = !environment.production;
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
    if (this.showSurvey) void this.loadSurvey();
    void this.loadSessionGeo();
    void this.loadPhoneUtils();
  }

  /**
   * Fetches libphonenumber in the background. A failure here is not worth
   * surfacing — `phoneError` keeps working off its length fallback.
   */
  private async loadPhoneUtils(): Promise<void> {
    if (!this.isBrowser) return;
    try {
      const { default: utils } = await import('intl-tel-input/utils');
      this.phoneUtils.set(utils);
    } catch {
      this.phoneUtils.set(null);
    }
  }

  private async loadSessionGeo(): Promise<void> {
    this.sessionGeo.set(await this.profileService.getSessionGeo());
  }

  private async loadProfile(): Promise<void> {
    const details = await this.profileService.getProfile();
    this.profile.set(details);
    this.fullName.set(details?.fullName ?? '');
    this.setPhoneFromE164(details?.phoneNumber ?? '');
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

  /** Seeds the country + national controls from the saved E.164 value. */
  private setPhoneFromE164(e164: string): void {
    const parts = splitE164(e164);
    if (!parts) {
      this.phoneNational.set('');
      return;
    }
    this.phoneCountryIso.set(parts.iso2);
    this.phoneNational.set(parts.national);
  }

  protected onPhoneCountryChange(iso2: string): void {
    this.phoneCountryIso.set(iso2);
    this.profileSaved.set(false);
  }

  /**
   * The national box takes digits only — the "+" and dial code come from the
   * picker. This works on the DOM value directly rather than through ngModel:
   * with a one-way `[value]` (or `[ngModel]`) binding, stripping a character
   * leaves the signal unchanged, Angular sees no new value to write, and the
   * rejected character stays on screen. `type="tel"` accepts any string by
   * spec, so the element itself won't stop letters either.
   */
  protected onPhoneNationalInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    const raw = input.value;
    const digits = raw.replace(/\D/g, '').slice(0, this.phoneNationalMaxLength());

    if (raw !== digits) {
      // Keep the caret where the user left it, counted in digits rather than
      // characters so removing one mid-string doesn't jump it to the end.
      const caret = input.selectionStart ?? raw.length;
      const digitsBeforeCaret = raw.slice(0, caret).replace(/\D/g, '').length;
      input.value = digits;
      input.setSelectionRange(digitsBeforeCaret, digitsBeforeCaret);
    }

    this.phoneNational.set(digits);
    this.profileSaved.set(false);
  }

  protected async saveProfile(): Promise<void> {
    const trimmedName = this.fullName().trim();
    if (!trimmedName) {
      this.profileError.set('Please enter a name.');
      return;
    }
    const phoneError = this.phoneError();
    if (phoneError) {
      this.profileError.set(phoneError);
      return;
    }

    this.savingProfile.set(true);
    this.profileError.set(null);
    this.profileSaved.set(false);

    const updates = {
      fullName: trimmedName,
      phoneNumber: this.phoneNumber(),
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
