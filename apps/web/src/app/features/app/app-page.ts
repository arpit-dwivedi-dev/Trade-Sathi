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
import { ButtonModule } from 'primeng/button';
import { ProgressSpinnerModule } from 'primeng/progressspinner';

import type { Instrument, MarketCode, MarketStatus } from '@chartanalyzer/shared';
import { AppIcon } from '../../shared/icons/app-icon';
import { AccountPage } from '../account/account-page';
import { AnalyzePage } from '../analyze/analyze-page';
import { BillingPage } from '../billing/billing-page';
import { BillingService } from '../billing/billing.service';
import { FundamentalsPage } from '../fundamentals/fundamentals-page';
import { HistoryList } from '../history/history-list';
import { LogsPage } from '../logs/logs-page';
import { DailyBriefing } from '../daily-briefing/daily-briefing';
import { WorkspacePage } from '../workspace/workspace-page';
import { NavRail, type NavTab } from '../../shared/nav-rail/nav-rail';
import { SymbolSearch, type SymbolSelection } from '../../shared/symbol-search/symbol-search';
import type { OpenInstrumentRequest } from './open-instrument';
import { AuthService } from '../../core/auth.service';
import { MarketStatusService } from '../../core/market-status.service';
import { ThemeService } from '../../core/theme.service';

/**
 * Fallback poll cadence, used only when a status has no nextChangeAt to
 * schedule against (already closed for the day, with tomorrow's calendar
 * unknown — see MarketStatus). Otherwise the badge updates itself with a
 * one-shot timer fired exactly at the known open/close boundary, which is
 * both more accurate and far cheaper than polling every minute while a
 * session is quietly in progress for hours.
 */
const MARKET_STATUS_FALLBACK_POLL_MS = 5 * 60_000;

/** apps/api's two session calendars — see market-status.service.ts. */
const STATUS_MARKET_BY_CODE: Readonly<Record<MarketCode, 'NSE' | 'NASDAQ'>> = {
  NSE: 'NSE',
  BSE: 'NSE',
  NASDAQ: 'NASDAQ',
  NYSE: 'NASDAQ',
};

/** The rail owns this list — it is the set of destinations it links to. */
type Tab = NavTab;

/**
 * The tabs whose content is a chart of one instrument, and so the tabs the
 * top bar's symbol search applies to. Everywhere else it is hidden (rather
 * than torn down — see the template) so a chart tab returns to the symbol
 * still written in the box.
 */
const SEARCHABLE_TABS: readonly Tab[] = ['workspace', 'dailyBriefing', 'fundamentals'];

const TABS: readonly Tab[] = [
  'analyze',
  'workspace',
  'dailyBriefing',
  'fundamentals',
  'history',
  'logs',
  'billing',
  'account',
];

/**
 * Plans and credits used to be two tabs. They are one screen now — a plan and a
 * credit pack answer the same question — but the old URLs are kept pointing at
 * it so a bookmark or an in-app link written against them still lands somewhere
 * real rather than silently falling back to Analyze. Same reason `watchlist`
 * is kept here: it was this tab's id before the Daily Briefing rename.
 */
const TAB_ALIASES: Readonly<Record<string, Tab>> = {
  pricing: 'billing',
  credits: 'billing',
  watchlist: 'dailyBriefing',
};

const TAB_TITLES: Readonly<Record<Tab, string>> = {
  analyze: 'Chart Image Analysis',
  workspace: 'Chart Analysis',
  history: 'Analysis History',
  dailyBriefing: 'Daily Briefing',
  fundamentals: 'Fundamentals',
  logs: 'Logs',
  billing: 'Billing',
  account: 'Account',
};

function parseTab(value: string | null): Tab {
  if (TABS.includes(value as Tab)) return value as Tab;
  return (value !== null ? TAB_ALIASES[value] : undefined) ?? 'analyze';
}

@Component({
  selector: 'app-app-page',
  imports: [
    AccountPage,
    AnalyzePage,
    BillingPage,
    FundamentalsPage,
    HistoryList,
    LogsPage,
    AppIcon,
    ButtonModule,
    ProgressSpinnerModule,
    NavRail,
    SymbolSearch,
    DailyBriefing,
    WorkspacePage,
  ],
  styleUrl: './app-page.css',
  templateUrl: './app-page.html',
})
export class AppPage implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly billing = inject(BillingService);
  private readonly marketStatusService = inject(MarketStatusService);
  private readonly router = inject(Router);
  private readonly themeService = inject(ThemeService);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly user = this.auth.user;
  protected readonly tab = signal<Tab>('analyze');
  protected readonly theme = this.themeService.theme;
  /**
   * The badge shows only the market currently selected in the top bar's
   * search (see SymbolSearch.marketChanged) — not every market at once.
   * Null until the first read completes, or if it fails, or before the
   * search has reported an initial market — the badge hides rather than
   * guessing.
   */
  protected readonly selectedStatusMarket = signal<'NSE' | 'NASDAQ' | null>(null);
  protected readonly marketStatus = signal<MarketStatus | null>(null);
  private marketStatusTimerId: ReturnType<typeof setTimeout> | null = null;
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
   * The instrument the workspace chart is showing, as chosen in the top bar's
   * one shared search. Kept rather than reset on every tab switch so coming
   * back to the tab shows the same chart instead of an empty search box. See
   * SymbolSelection for the requestId.
   */
  protected readonly workspaceSelection = signal<SymbolSelection | null>(null);
  /**
   * The daily briefing's is a staged add rather than a chart, so it is dropped
   * on the way out of the tab — that screen is remounted on every visit, and a
   * kept value would re-stage last week's symbol under the Add button.
   */
  protected readonly dailyBriefingSelection = signal<SymbolSelection | null>(null);
  /**
   * Fundamentals is not a chart, but it is the same question — which symbol
   * are we looking at — so it gets the same kept-per-tab treatment: coming
   * back to the tab shows the company that was being read, not an empty
   * screen.
   */
  protected readonly fundamentalsSelection = signal<SymbolSelection | null>(null);
  private selectionSeq = 0;

  /**
   * AnalyzePage stays mounted for the life of the shell (it is hidden, not
   * destroyed, on the History tab), so this reference is stable. It is how a
   * purchase made on the billing tab reaches the page's reset — including a
   * purchase started from the nav while the page sits in
   * insufficient_credits, which an output wired only to that block would
   * miss.
   */
  private readonly analyzePage = viewChild(AnalyzePage);

  /**
   * The top bar's search. Mounted for the life of the shell (hidden, never
   * destroyed, on the tabs it does not apply to), so this reference is
   * stable — it is how the daily briefing's staged add hands the box back
   * after an add or cancel (see clearSearch).
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
      // See dailyBriefingSelection: a staged add does not survive leaving.
      if (tab !== 'dailyBriefing') this.dailyBriefingSelection.set(null);
    });

    // The one credit balance read for the whole shell. Everything downstream —
    // the rail's balance label, the analyze/fundamentals/daily-briefing
    // screens, the billing tab — reads the cache it fills rather than
    // querying again.
    void this.billing.ensureCreditBalance();

    // Same idea for the price list: the buy-credits control and the billing
    // tab label themselves from it, and reading it once here means it is
    // priced by the time either surface is opened. The endpoint resolves the
    // region from this account's locked profile column.
    void this.billing.ensurePricing();

    this.destroyRef.onDestroy(() => this.clearMarketStatusTimer());
  }

  /**
   * The top bar search reporting which market it's scoped to (see
   * SymbolSearch.marketChanged) — fires once on init and again on every
   * manual switch. A switch drops whatever timer was scheduled for the old
   * market and reads the new one immediately rather than waiting for it.
   */
  protected onSearchMarketChanged(market: MarketCode): void {
    const statusMarket = STATUS_MARKET_BY_CODE[market];
    if (statusMarket === this.selectedStatusMarket()) return;
    this.selectedStatusMarket.set(statusMarket);
    this.clearMarketStatusTimer();
    void this.refreshMarketStatus();
  }

  private async refreshMarketStatus(): Promise<void> {
    const market = this.selectedStatusMarket();
    if (!market) return;
    const status = await this.marketStatusService.fetchStatus(market);
    // The selection may have changed while the request was in flight; a
    // stale response for the market just switched away from must not
    // overwrite what the new one already set.
    if (this.selectedStatusMarket() !== market) return;
    this.marketStatus.set(status);
    this.scheduleNextMarketStatusRead(status);
  }

  /**
   * One-shot timer instead of a fixed poll: nextChangeAt is the exact moment
   * NSE/Yahoo's own published session boundary flips this market's state, so
   * there is nothing to gain from checking any earlier — and no third-party
   * webhook exists for "market just opened/closed" to push it instead. Only
   * when the boundary is unknown (already closed for the day, with
   * tomorrow's calendar not given by this endpoint) does this fall back to a
   * plain interval.
   */
  private scheduleNextMarketStatusRead(status: MarketStatus | null): void {
    this.clearMarketStatusTimer();
    const delayMs = status?.nextChangeAt
      ? new Date(status.nextChangeAt).getTime() - Date.now() + 1_000
      : MARKET_STATUS_FALLBACK_POLL_MS;
    this.marketStatusTimerId = setTimeout(
      () => void this.refreshMarketStatus(),
      Math.max(delayMs, 1_000),
    );
  }

  private clearMarketStatusTimer(): void {
    if (this.marketStatusTimerId !== null) {
      clearTimeout(this.marketStatusTimerId);
      this.marketStatusTimerId = null;
    }
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
    else if (this.tab() === 'dailyBriefing') this.dailyBriefingSelection.set(selection);
    else if (this.tab() === 'fundamentals') this.fundamentalsSelection.set(selection);
  }

  /** The daily briefing tab asking for the box back after an add (or a cancel). */
  protected clearSearch(): void {
    this.dailyBriefingSelection.set(null);
    this.symbolSearch()?.clear();
  }

  protected toggleNav(): void {
    this.navOpen.update((open) => !open);
  }

  protected closeNav(): void {
    this.navOpen.set(false);
  }

  /**
   * Billing is a plain tab now, not a popup — see plans-overlay.ts removal.
   * Both entry points (the nav rail's own link and the "not enough credits"
   * block's button) land here so they behave identically.
   */
  protected openPlans(): void {
    this.select('billing');
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

  /**
   * A child tab (History, Daily Briefing) reopening an instrument on its own
   * destination tab. Sets that tab's per-tab selection then switches to it —
   * the same path a top-bar search pick takes, so the reopened symbol lands on
   * the Analyze-by-Symbol chart or Fundamentals screen already loaded rather
   * than on a blank one.
   */
  protected onOpenInstrument({ instrument, tab }: OpenInstrumentRequest): void {
    const selection: SymbolSelection = { instrument, requestId: ++this.selectionSeq };
    if (tab === 'fundamentals') this.fundamentalsSelection.set(selection);
    else this.workspaceSelection.set(selection);
    this.select(tab);
  }

  protected async signOut(): Promise<void> {
    await this.auth.signOut();
    await this.router.navigateByUrl('/login');
  }
}
