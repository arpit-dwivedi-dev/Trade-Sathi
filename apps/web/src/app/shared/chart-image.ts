import { Component, computed, effect, inject, input, signal } from '@angular/core';

import { SupabaseClientService } from '../core/supabase-client';

const BUCKET = 'chart-images';

/** How long a generated URL stays valid. Long enough to read the analysis
 *  around it, short enough that a copied URL is not a lasting leak. */
const SIGNED_URL_TTL_SECONDS = 3600;

/**
 * Shows the chart image an analysis was run on.
 *
 * The bucket is private, so a raw `image_key` is not loadable as an `src`:
 * this signs it first. The read is allowed by the bucket's own RLS policy
 * (objects live under `{profile_id}/…`), so it goes straight from the browser
 * client — no backend endpoint, the same read-your-own-data path history uses.
 */
@Component({
  selector: 'app-chart-image',
  templateUrl: './chart-image.html',
  styleUrl: './chart-image.css',
})
export class ChartImage {
  private readonly supabase = inject(SupabaseClientService);

  readonly imageKey = input.required<string | null>();
  /** Used for alt text; falls back to a generic description. */
  readonly label = input<string | null>(null);
  /** Small, unframed thumbnail (e.g. a history-table cell) instead of the full report figure. */
  readonly compact = input(false);
  /** Prioritise the full report image so it is present during an immediate print/screenshot. */
  readonly priority = input(false);

  protected readonly url = signal<string | null>(null);
  protected readonly loading = signal(false);
  protected readonly failed = signal(false);

  protected readonly alt = computed(() => {
    const label = this.label();
    return label ? `Chart analyzed for ${label}` : 'The chart image this analysis was run on';
  });

  constructor() {
    effect(() => {
      const key = this.imageKey();
      this.url.set(null);
      this.failed.set(false);
      // SSR has no Supabase client (and no session); the browser re-runs this.
      if (!key || !this.supabase.client) {
        this.loading.set(false);
        return;
      }
      void this.sign(key);
    });
  }

  private async sign(key: string): Promise<void> {
    this.loading.set(true);
    try {
      const { data, error } = await this.supabase.client!.storage
        .from(BUCKET)
        .createSignedUrl(key, SIGNED_URL_TTL_SECONDS);
      if (error || !data) throw error ?? new Error('Signing returned no URL');

      // A slower sign for an image the view has since swapped away from must
      // not paint over the current one.
      if (this.imageKey() !== key) return;
      this.url.set(data.signedUrl);
    } catch (cause) {
      console.warn('chart image signing failed', cause);
      if (this.imageKey() !== key) return;
      this.failed.set(true);
    } finally {
      if (this.imageKey() === key) this.loading.set(false);
    }
  }
}
