import { AfterViewInit, Component, ElementRef, OnDestroy, input, viewChild } from '@angular/core';
import lottie, { type AnimationItem } from 'lottie-web';

/**
 * Thin wrapper around lottie-web: plays a JSON animation from `public/` on
 * loop. No ngx-lottie dependency needed for a single looping animation.
 */
@Component({
  selector: 'app-lottie-player',
  template: '<div #host class="lottie-host"></div>',
  styles: [':host { display: block; } .lottie-host { width: 100%; height: 100%; }'],
})
export class LottiePlayer implements AfterViewInit, OnDestroy {
  readonly path = input.required<string>();

  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private animation: AnimationItem | null = null;

  ngAfterViewInit(): void {
    this.animation = lottie.loadAnimation({
      container: this.host().nativeElement,
      renderer: 'svg',
      loop: true,
      autoplay: true,
      path: this.path(),
    });
  }

  ngOnDestroy(): void {
    this.animation?.destroy();
  }
}
