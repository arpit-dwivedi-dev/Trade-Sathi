import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';
import { provideClientHydration } from '@angular/platform-browser';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { FullscreenOverlayContainer, OverlayContainer } from '@angular/cdk/overlay';
import { MAT_ICON_DEFAULT_OPTIONS } from '@angular/material/icon';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideClientHydration(),
    // withFetch: XHR does not exist during SSR.
    provideHttpClient(withFetch()),
    provideAnimationsAsync(),
    // Every <mat-icon> in the app draws glyphs by name from Material Symbols
    // rather than the older Material Icons ligature font.
    { provide: MAT_ICON_DEFAULT_OPTIONS, useValue: { fontSet: 'material-symbols-outlined' } },
    // Menus, autocompletes and tooltips are rendered into the CDK overlay
    // container, which by default hangs off <body>. The workspace's Full
    // screen control (WorkspacePage.toggleFullscreen) fullscreens its own
    // shell element, and a fullscreen element is the only subtree the browser
    // paints — so every overlay opened from in there was landing outside it,
    // invisible and unclickable. This container follows the fullscreen
    // element instead, which is exactly what the CDK ships it for.
    { provide: OverlayContainer, useClass: FullscreenOverlayContainer },
  ],
};
