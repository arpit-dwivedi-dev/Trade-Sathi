import {
  Component,
  DestroyRef,
  OnInit,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

import type { Instrument } from '@chartanalyzer/shared';
import { AnalyzePage } from '../analyze/analyze-page';
import { BillingPage } from '../billing/billing-page';
import { BillingService } from '../billing/billing.service';
import { PlansOverlay } from '../billing/plans-overlay';
import { HistoryList } from '../history/history-list';
import { LivePage } from '../live/live-page';
import { LogsPage } from '../logs/logs-page';
import { Watchlist } from '../watchlist/watchlist';
import { WorkspacePage } from '../workspace/workspace-page';
import { NavRail, type NavTab } from '../../shared/nav-rail/nav-rail';
import { SymbolSearch, type SymbolSelection } from '../../shared/symbol-search/symbol-search';
import { AuthService } from '../../core/auth.service';
import { ThemeService } from '../../core/theme.service';

/** The rail owns this list — it is the set of destinations it links to. */
type Tab = NavTab;

/**
 * The tabs whose content is a chart of one instrument, and so the tabs the
 * top bar's symbol search applies to. Everywhere else it is hidden (rather
 * than torn down — see the template) so a chart tab returns to the symbol
 * still written in the box.
 */
const SEARCHABLE_TABS: readonly Tab[] = ['live', 'workspace', 'watchlist'];

const TABS: readonly Tab[] = [
  'live',
  'analyze',
  'workspace',
  'watchlist',
  'history',
  'logs',
  'billing',
];

/**
 * Plans and credits used to be two tabs. They are one screen now — a plan and a
 * credit pack answer the same question — but the old URLs are kept pointing at
 * it so a bookmark or an in-app link written against them still lands somewhere
 * real rather than silently falling back to Analyze.
 */
const TAB_ALIASES: Readonly<Record<string, Tab>> = {
  pricing: 'billing',
  credits: 'billing',
};

const TAB_TITLES: Readonly<Record<Tab, string>> = {
  analyze: 'Chart Image Analysis',
  live: 'Live Chart Analysis',
  workspace: 'Manual Chart Analysis',
  history: 'Analysis History',
  watchlist: 'Watch List',
  logs: 'Logs',
  billing: 'Billing',
};

function parseTab(value: string | null): Tab {
  if (TABS.includes(value as Tab)) return value as Tab;
  return (value !== null ? TAB_ALIASES[value] : undefined) ?? 'analyze';
}

@Component({
  selector: 'app-app-page',
  imports: [
    AnalyzePage,
    BillingPage,
    HistoryList,
    LivePage,
    LogsPage,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    NavRail,
    PlansOverlay,
    SymbolSearch,
    Watchlist,
    WorkspacePage,
  ],
  styleUrl: './app-page.css',
  templateUrl: './app-page.html',
})
export class AppPage implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly billing = inject(BillingService);
  private readonly router = inject(Router);
  private readonly themeService = inject(ThemeService);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly user = this.auth.user;
  protected readonly tab = signal<Tab>('analyze');
  protected readonly theme = this.themeService.theme;
  protected readonly plansOpen = signal(false);
  /** Drawer state. Only consulted below 900px, where the rail is off-canvas. */
  protected readonly navOpen = signal(false);
  /**
   * Desktop-only collapse, distinct from navOpen above (that one is the
   * off-canvas mobile drawer). The rail hides itself outright below 900px
   * already, so this only has anything to do above it. Collapsed means an
   * icon-only rail, never a hidden one — the icons and the toggle stay on
   * screen, so it survives a tab change without stranding anyone.
   */
  protected readonly navCollapsed = signal(false);
  /**
   * The instrument each chart tab is showing, as chosen in the top bar's one
   * shared search. Kept per tab rather than as a single value: Live and the
   * workspace are two independent charts, and picking a symbol while looking
   * at one must not silently swap the other out from under an in-flight
   * analysis or a set of drawings. See SymbolSelection for the requestId.
   */
  protected readonly liveSelection = signal<SymbolSelection | null>(null);
  protected readonly workspaceSelection = signal<SymbolSelection | null>(null);
  /**
   * The watchlist's is a staged add rather than a chart, so it is dropped on
   * the way out of the tab — that screen is remounted on every visit, and a
   * kept value would re-stage last week's symbol under the Add button.
   */
  protected readonly watchlistSelection = signal<SymbolSelection | null>(null);
  private selectionSeq = 0;

  /**
   * AnalyzePage stays mounted for the life of the shell (it is hidden, not
   * destroyed, on the History tab), so this reference is stable. It is how a
   * purchase made in the overlay reaches the page's reset — including a
   * purchase started from the nav while the page sits in quota_exceeded, which
   * an output wired only to the quota block would miss.
   */
  private readonly analyzePage = viewChild(AnalyzePage);

  /**
   * The top bar's search. Mounted for the life of the shell (hidden, never
   * destroyed, on the tabs it does not apply to), so this reference is
   * stable — it is how the Live → workspace handoff leaves the box reading
   * the symbol it opened.
   */
  private readonly symbolSearch = viewChild(SymbolSearch);

  ngOnInit(): void {
    // The tab lives in the URL so links from outside the shell — the Account
    // page's nav, a bookmark — can land on a specific tab. Subscribed rather
    // than read once: navigating to /app?tab=… while already here reuses this
    // component instance, so only the param stream reports the change.
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const tab = parseTab(params.get('tab'));
      this.tab.set(tab);
      // See watchlistSelection: a staged add does not survive leaving.
      if (tab !== 'watchlist') this.watchlistSelection.set(null);
    });

    // The one plan read for the whole shell. Everything downstream — the
    // rail's CTA label, the overlay, the plan picker's "Current plan" marker —
    // reads the cache it fills rather than querying again.
    void this.billing.ensurePlanSummary();
  }

  /** Names the current screen in the top bar, beside the drawer toggle. */
  protected pageTitle(): string {
    return TAB_TITLES[this.tab()];
  }

  /** Whether the top bar's symbol search applies to the current tab. */
  protected searchVisible(): boolean {
    return SEARCHABLE_TABS.includes(this.tab());
  }

  /** Routes a symbol picked in the top bar to whichever chart tab is open. */
  protected onInstrumentSelected(instrument: Instrument): void {
    const selection: SymbolSelection = { instrument, requestId: ++this.selectionSeq };
    if (this.tab() === 'workspace') this.workspaceSelection.set(selection);
    else if (this.tab() === 'live') this.liveSelection.set(selection);
    else if (this.tab() === 'watchlist') this.watchlistSelection.set(selection);
  }

  /** The watchlist asking for the box back after an add (or a cancel). */
  protected clearSearch(): void {
    this.watchlistSelection.set(null);
    this.symbolSearch()?.clear();
  }

  protected toggleNav(): void {
    this.navOpen.update((open) => !open);
  }

  protected closeNav(): void {
    this.navOpen.set(false);
  }

  /**
   * Opens the workspace tab, optionally on a specific instrument — the Live
   * tab's "Manual Analysis" button calls this with the symbol already on
   * screen there, so the handoff lands on the same chart instead of an empty
   * search box.
   */
  protected openWorkspace(instrument: Instrument | null): void {
    if (instrument) {
      this.workspaceSelection.set({ instrument, requestId: ++this.selectionSeq });
      // The box is shared, and the workspace is about to open on this
      // symbol — so it should read as though it had been searched for here.
      this.symbolSearch()?.setDisplayText(`${instrument.symbol} — ${instrument.name}`);
    }
    this.select('workspace');
  }

  protected openPlans(): void {
    this.plansOpen.set(true);
  }

  protected closePlans(): void {
    this.plansOpen.set(false);
  }

  protected onUpgraded(): void {
    this.analyzePage()?.onUpgraded();
  }

  protected onCreditsAdded(): void {
    this.analyzePage()?.onCreditsAdded();
  }

  protected toggleTheme(): void {
    this.themeService.toggle();
  }

  /**
   * Writes the tab to the URL; the queryParamMap subscription above is what
   * actually flips the signal, so in-shell clicks and external links take the
   * identical path. replaceUrl keeps tab switching out of the back stack.
   */
  protected select(tab: Tab): void {
    this.navOpen.set(false);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab },
      replaceUrl: true,
    });
  }

  protected async signOut(): Promise<void> {
    await this.auth.signOut();
    await this.router.navigateByUrl('/login');
  }
}
