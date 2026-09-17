import { Component, inject, output, signal } from '@angular/core';
import { ButtonModule } from 'primeng/button';

import { BillingService } from './billing.service';

/**
 * The promo-code redeem control: an input, a Redeem button, and the
 * per-outcome result message.
 *
 * Pulled out of PlansOverlay once BillingPage grew a second, real call site
 * for it — a paywalled account can reach either surface (the nav's "Buy
 * credits" opens the overlay; the Billing tab renders BillingPage directly),
 * and only one of them offering a way to redeem a code was the gap: a user
 * who landed on the Billing tab first had no redeem box at all. One
 * component now, not two copies that could drift.
 *
 * Owns no purchase flow of its own — a single POST with no checkout window
 * and no polling — so it needs no busy/cancel machinery beyond the one
 * `busy` signal.
 */
@Component({
  selector: 'app-promo-redeem-box',
  imports: [ButtonModule],
  styleUrl: './promo-redeem-box.css',
  templateUrl: './promo-redeem-box.html',
})
export class PromoRedeemBox {
  private readonly billing = inject(BillingService);

  /** Emitted only on 'applied' — the caller refreshes whatever balance it shows. */
  readonly redeemed = output<void>();

  protected readonly code = signal('');
  protected readonly busy = signal(false);
  protected readonly message = signal<{ text: string; tone: 'ok' | 'err' } | null>(null);

  protected async onRedeem(): Promise<void> {
    const value = this.code().trim();
    if (value.length === 0 || this.busy()) return;

    this.busy.set(true);
    this.message.set(null);
    try {
      const result = await this.billing.redeemPromoCode(value);
      if (result.ok) {
        this.code.set('');
        this.message.set({ text: 'Code applied — credits added to your balance.', tone: 'ok' });
        // The balance this control's callers display comes from the shared
        // credit balance; refresh it so "applied" is immediately visible, not
        // just claimed.
        void this.billing.refreshCreditBalance();
        this.redeemed.emit();
      } else {
        // Worded per outcome so the user knows whether to retype, wait, or
        // stop; 'invalid_code' is deliberately vague to match the backend.
        //
        // It is also where a discount code lands: the backend collapses
        // "unknown" and "exists, but only discounts" into this one answer so
        // the box cannot be used to enumerate codes. The user holding a
        // perfectly good discount code has no way to tell that from a typo, so
        // the message points at the other box rather than leaving them
        // retyping the same code.
        this.message.set({
          text:
            result.outcome === 'duplicate'
              ? 'You have already used that code.'
              : result.outcome === 'expired'
                ? 'That code has expired.'
                : result.outcome === 'exhausted'
                  ? 'That code has reached its redemption limit.'
                  : result.outcome === 'not_eligible_region'
                    ? "That code isn't available in your region."
                    : "That code isn't valid. Discount codes go in the Buy credits box.",
          tone: 'err',
        });
      }
    } finally {
      this.busy.set(false);
    }
  }
}
