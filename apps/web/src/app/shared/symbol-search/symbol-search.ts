import { HttpClient } from '@angular/common/http';
import {
  Component,
  DestroyRef,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { MatAutocompleteModule } from '@angular/material/autocomplete';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { Subject, firstValueFrom } from 'rxjs';
import { debounceTime, distinctUntilChanged, switchMap } from 'rxjs/operators';

import { MARKETS, type Instrument, type MarketCode } from '@chartanalyzer/shared';
import { AuthService } from '../../core/auth.service';
import { ProfileService } from '../../features/account/profile.service';

/** geoip country code -> the market a trader from that country almost always means. */
const MARKET_BY_COUNTRY: Record<string, MarketCode> = {
  IN: 'NSE',
  US: 'NASDAQ',
};

const SEARCH_DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 2;

/**
 * One instrument chosen in the shell's top-bar search, handed to whichever
 * chart tab is showing. The requestId is what makes the same symbol picked
 * twice in a row a new value by reference, so the receiving page's effect
 * still fires — a bare Instrument signal would be seen as unchanged.
 */
export interface SymbolSelection {
  instrument: Instrument;
  requestId: number;
}

/**
 * Market + typeahead symbol search. Owns the market filter and the debounced
 * /api/instruments/search call; a parent only ever sees a chosen instrument
 * via (instrumentSelected). What happens after selection (reload a chart,
 * stage a daily briefing add, ...) is deliberately left to the parent, since
 * the screens that need it each do something different with it.
 *
 * There is now one instance for the whole dashboard, in the shell's top bar
 * (see AppPage) — it used to be re-rendered inside Live, Workspace and
 * Daily Briefing, which put three separate search boxes on screen for what is
 * one question: which symbol are we looking at.
 */
@Component({
  selector: 'app-symbol-search',
  imports: [
    FormsModule,
    MatAutocompleteModule,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatSelectModule,
  ],
  templateUrl: './symbol-search.html',
  styleUrl: './symbol-search.css',
})
export class SymbolSearch {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly profileService = inject(ProfileService);
  private readonly destroyRef = inject(DestroyRef);

  readonly instrumentSelected = output<Instrument>();
  /** Fires on init (once the geo default resolves) and on every manual switch. */
  readonly marketChanged = output<MarketCode>();
  readonly placeholder = input('Search symbol or company, e.g. RELIANCE');

  protected readonly markets = MARKETS;
  protected readonly market = signal<MarketCode>('NSE');
  protected readonly queryInput = signal('');
  protected readonly results = signal<Instrument[]>([]);
  protected readonly searching = signal(false);
  protected readonly searched = signal(false);

  private readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('search');
  private readonly querySubject = new Subject<string>();

  constructor() {
    this.querySubject
      .pipe(
        debounceTime(SEARCH_DEBOUNCE_MS),
        distinctUntilChanged(),
        switchMap((q) => this.search(q)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((instruments) => {
        this.results.set(instruments);
        this.searching.set(false);
        this.searched.set(true);
      });

    void this.applyGeoDefaultMarket();
  }

  /** The default 'NSE' the market signal starts with, before geo resolves. */
  ngAfterViewInit(): void {
    this.marketChanged.emit(this.market());
  }

  /**
   * Picks the market a trader from the detected region almost certainly
   * means, so they don't have to switch it manually every session. Only
   * applies before the user has typed/searched anything — a lookup that
   * resolves after they've already started shouldn't yank the market out
   * from under a query in progress.
   */
  private async applyGeoDefaultMarket(): Promise<void> {
    const geo = await this.profileService.getSessionGeo();
    const inferred = geo?.country ? MARKET_BY_COUNTRY[geo.country] : undefined;
    if (inferred && this.queryInput().trim().length === 0 && inferred !== this.market()) {
      this.market.set(inferred);
      this.marketChanged.emit(inferred);
    }
  }

  protected onQueryChange(value: string): void {
    // mat-autocomplete's trigger writes the selected option's value (a whole
    // Instrument, per the [value] binding in the template) back through the
    // same control on selection, which fires this same handler — genuine
    // typing is the only case this method exists for, so anything else is
    // ignored; onOptionSelected already owns the post-selection state.
    if (typeof value !== 'string') return;

    this.queryInput.set(value);
    const trimmed = value.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      this.results.set([]);
      this.searching.set(false);
      this.searched.set(false);
      return;
    }
    this.searching.set(true);
    this.querySubject.next(trimmed);
  }

  /**
   * Switching markets invalidates whatever was typed for the previous one.
   * Re-runs the search directly rather than through querySubject: that
   * pipeline's distinctUntilChanged would swallow an unchanged query string,
   * which is exactly the case here (same text, different market).
   */
  protected onMarketChange(value: MarketCode): void {
    this.market.set(value);
    this.marketChanged.emit(value);
    const trimmed = this.queryInput().trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      this.results.set([]);
      this.searched.set(false);
      return;
    }
    this.searching.set(true);
    void this.search(trimmed).then((instruments) => {
      this.results.set(instruments);
      this.searching.set(false);
      this.searched.set(true);
    });
  }

  private async search(query: string): Promise<Instrument[]> {
    const token = await this.auth.getAccessToken();
    if (!token) return [];
    try {
      const response = await firstValueFrom(
        this.http.get<{ instruments: Instrument[] }>('/api/instruments/search', {
          params: { q: query, market: this.market() },
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      return response.instruments;
    } catch {
      return [];
    }
  }

  /** Dismisses the suggestion list without choosing anything. */
  protected dismissResults(): void {
    this.results.set([]);
    this.searched.set(false);
  }

  /** Empties the search box and returns focus to it. */
  protected clearQuery(): void {
    this.onQueryChange('');
    this.searchInput()?.nativeElement.focus();
  }

  /**
   * A palette to color each instrument's initials avatar with, so results
   * don't all render as identical gray circles. Chosen deterministically
   * from the symbol below rather than randomly, so the same instrument
   * always gets the same color across searches and re-renders.
   */
  private static readonly AVATAR_COLORS = [
    '#2563eb',
    '#7c3aed',
    '#db2777',
    '#dc2626',
    '#d97706',
    '#65a30d',
    '#059669',
    '#0891b2',
  ];

  /**
   * Two-letter initials avatar in place of a real company logo. A remote
   * logo (Clearbit, then Google's favicon service keyed by a guessed
   * domain) was tried first, but both approaches either don't resolve at
   * all (Clearbit's logo API was shut down after its HubSpot acquisition)
   * or fail for the majority of NSE/BSE tickers whose domain can't be
   * guessed from the company name (abbreviations, group names) — Google's
   * favicon endpoint also never 404s, so a bad guess couldn't even be
   * reliably detected. This has no such gap: it renders from data already
   * on the instrument and needs no network round trip per result, per
   * keystroke.
   */
  protected initials(instrument: Instrument): string {
    return instrument.symbol.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase();
  }

  /** Deterministic color pick so the same symbol always renders the same. */
  protected avatarColor(instrument: Instrument): string {
    let hash = 0;
    for (const ch of instrument.symbol) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
    const colors = SymbolSearch.AVATAR_COLORS;
    return colors[Math.abs(hash) % colors.length];
  }

  /**
   * The server already checked the logo URL resolves before caching it, so
   * this is only for a transient failure (network blip, the external host
   * going down after the fact) — hide the broken image rather than show one.
   */
  protected onLogoError(event: Event): void {
    (event.target as HTMLImageElement).style.visibility = 'hidden';
  }

  protected onOptionSelected(instrument: Instrument): void {
    this.queryInput.set(`${instrument.symbol} — ${instrument.name}`);
    this.results.set([]);
    this.searched.set(false);
    this.instrumentSelected.emit(instrument);
  }

  /**
   * Lets a parent reset the box after consuming a selection — the shell
   * clears it once the watchlist has added an instrument.
   */
  clear(): void {
    this.queryInput.set('');
    this.results.set([]);
    this.searched.set(false);
  }
}
