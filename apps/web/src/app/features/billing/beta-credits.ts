import { Component, output } from '@angular/core';

import { BETA_PROMO_CODE, BETA_PROMO_CREDITS } from './free-beta';
import { PromoRedeemBox } from './promo-redeem-box';

/**
 * Where an account gets credits while purchases are paused: names the
 * free-beta code and puts it in a redeem box, already filled in.
 *
 * Shown on the Billing screen and wherever a run is refused for lack of
 * credits — the places a Buy button would otherwise be.
 */
@Component({
  selector: 'app-beta-credits',
  imports: [PromoRedeemBox],
  styleUrl: './beta-credits.css',
  templateUrl: './beta-credits.html',
})
export class BetaCredits {
  /** Re-emitted from the redeem box on 'applied', so the host can clear its out-of-credits state. */
  readonly redeemed = output<void>();

  protected readonly code = BETA_PROMO_CODE;
  protected readonly credits = BETA_PROMO_CREDITS;
}
