import type { Instrument } from '@tradesathi/shared';

/**
 * The shell tab an instrument can be opened onto from inside another tab.
 * 'symbol-search' is the chart workspace; 'fundamentals' is the
 * Fundamentals tab. Both are NavTabs, named as nav-tabs.ts names them.
 */
export type ChartDestinationTab = 'symbol-search' | 'fundamentals';

/**
 * Request a child tab (History, Daily Briefing) raises when the user clicks a
 * company/symbol to reopen it elsewhere. The shell owns the per-tab selection
 * signals and the current tab, so it is the one that routes this — see
 * AppPage.onOpenInstrument.
 */
export interface OpenInstrumentRequest {
  instrument: Instrument;
  tab: ChartDestinationTab;
}
