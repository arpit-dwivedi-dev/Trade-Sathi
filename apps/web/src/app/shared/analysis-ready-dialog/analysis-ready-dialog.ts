import { Component, ElementRef, afterRenderEffect, input, output, viewChild } from '@angular/core';
import { ButtonModule } from 'primeng/button';

/** A finished analysis the user has not been shown yet. */
export interface ReadyAnalysis {
  /** The analyses row id: /analysis/:id opens its report. */
  id: string;
  symbol: string;
  kind: 'chart' | 'fundamentals';
}

/**
 * "Your analysis is ready", with a way straight to the report page.
 *
 * A finished run's result is never rendered where the run was started: the
 * report has a page of its own (/analysis/:id), and this is how the user gets
 * there. Hosted once by the app shell rather than by each screen, so it shows
 * whichever tab the user has moved to while the run was going. A screen
 * pane is only hidden when its tab is not active, so a dialog inside it would
 * never be seen.
 *
 * Dismissing it loses nothing. The screen that started the run keeps a link
 * to the report, and every run is also listed in History.
 */
@Component({
  selector: 'app-analysis-ready-dialog',
  imports: [ButtonModule],
  templateUrl: './analysis-ready-dialog.html',
  styleUrl: './analysis-ready-dialog.css',
})
export class AnalysisReadyDialog {
  readonly ready = input.required<ReadyAnalysis>();

  /** Open the report. */
  readonly view = output<void>();

  /** Later, the overlay, or Escape. */
  readonly dismissed = output<void>();

  private readonly viewButton = viewChild('viewButton', { read: ElementRef });

  constructor() {
    // Focus the way forward whenever an analysis is announced, including the
    // next one queued behind a dismissed one: Enter opens the report and
    // Escape closes, with no pointer needed.
    afterRenderEffect(() => {
      this.ready();
      (this.viewButton()?.nativeElement as HTMLElement | undefined)?.focus();
    });
  }
}
