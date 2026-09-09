import type { Instrument } from '@chartanalyzer/shared';

/**
 * The shell tab an instrument can be opened onto from inside another tab.
 * 'workspace' is the "Analyze by Symbol" chart workspace; 'fundamentals' is
 * the Fundamentals tab.
 */
export type ChartDestinationTab = 'workspace' | 'fundamentals';

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
