/**
 * The app shell's destinations — every screen the nav rail links to, and the
 * one name each of them goes by.
 *
 * A destination is named exactly once, here. Its id *is* its URL segment
 * (`/app/<tab>`), and it is the nav label cut down to kebab-case, so the rail
 * row, the address bar and the top bar's title can never disagree about what a
 * screen is called. That is the whole point of the shape: there used to be a
 * short internal id living beside a longer display name, and the two drifted —
 * a row reading "Analyze by Symbol" sat over a route called `workspace`.
 *
 * This is its own module, with no component imports, because two route
 * configuration files need the destination list (the client routes and the
 * prerender routes). Importing it from the rail or from app-page.ts would drag
 * a component tree into the initial bundle — NavRail's own services, or the
 * whole shell and every tab it hosts — defeating the routes' loadComponent
 * laziness.
 */
export type NavTab =
  | 'analyze-by-image'
  | 'symbol-search'
  | 'daily-briefing'
  | 'fundamentals'
  | 'history'
  | 'activity-logs'
  | 'billing'
  | 'account-settings'
  | 'admin';

/** Every destination, in the order the modals and the prerenderer enumerate them. */
export const TABS: readonly NavTab[] = [
  'analyze-by-image',
  'symbol-search',
  'daily-briefing',
  'fundamentals',
  'history',
  'activity-logs',
  'billing',
  'account-settings',
  'admin',
];

/**
 * What each destination is called on screen — the nav row's label, the title
 * the top bar shows, and the words its URL was cut from. Read by NavRail and by
 * AppPage.pageTitle rather than written out twice, so a rename here is the
 * whole rename.
 */
export const TAB_LABELS: Readonly<Record<NavTab, string>> = {
  'analyze-by-image': 'Analyze by Image',
  'symbol-search': 'Symbol Search',
  'daily-briefing': 'Daily Briefing',
  fundamentals: 'Fundamentals',
  history: 'History',
  'activity-logs': 'Activity Logs',
  billing: 'Billing',
  'account-settings': 'Account Settings',
  admin: 'Admin',
};

/**
 * Names these destinations used to answer to, so a bookmark or an in-app link
 * written against one still lands somewhere real instead of falling back to the
 * default.
 *
 * Two generations are here. Plans and credits were merged into one Billing
 * screen, and `watchlist` is what the Daily Briefing tab was called before it
 * was renamed. The rest are the short ids these tabs carried before their URLs
 * were cut from the nav label — `workspace` for what the rail has always shown
 * as "Analyze by Symbol", and so on. `dailyBriefing` is the camelCase it used
 * to be, which is the one that would look like a typo if it were dropped.
 */
export const TAB_ALIASES: Readonly<Record<string, NavTab>> = {
  pricing: 'billing',
  credits: 'billing',
  watchlist: 'daily-briefing',
  analyze: 'analyze-by-image',
  workspace: 'symbol-search',
  // What this tab's URL was while it was called "Analyze by Symbol".
  'analyze-by-symbol': 'symbol-search',
  dailyBriefing: 'daily-briefing',
  logs: 'activity-logs',
  account: 'account-settings',
};

/** The destination a URL names, or the default when it names nothing that exists. */
export function parseTab(value: string | null): NavTab {
  if (TABS.includes(value as NavTab)) return value as NavTab;
  return (value !== null ? TAB_ALIASES[value] : undefined) ?? 'analyze-by-image';
}
