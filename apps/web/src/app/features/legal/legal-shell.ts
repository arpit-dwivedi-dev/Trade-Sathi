import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * The frame the public policy pages share (Terms, Privacy, Contact): a brand
 * bar, a readable column, and the same footer links, so each page holds only
 * its own words.
 *
 * Styled as part of the marketing site rather than the app (see
 * landing-page.css). These pages are linked from the landing page's footer
 * and read by visitors who may not have an account.
 *
 * The page's own text is projected, so it is styled by the page component
 * (legal-prose.css) rather than here — emulated encapsulation keeps this
 * stylesheet from reaching projected nodes. The palette below still applies
 * to them: custom properties inherit through the DOM regardless.
 */
@Component({
  selector: 'app-legal-shell',
  imports: [RouterLink],
  styleUrl: './legal-shell.css',
  templateUrl: './legal-shell.html',
})
export class LegalShell {
  readonly heading = input.required<string>();
  /** "Last updated" date, for the policy pages. Contact has none. */
  readonly updated = input<string | null>(null);
}
