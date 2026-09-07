import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';
import { provideClientHydration } from '@angular/platform-browser';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { providePrimeNG } from 'primeng/config';
import { AppPreset } from './core/primeng-preset';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideClientHydration(),
    // withFetch: XHR does not exist during SSR.
    provideHttpClient(withFetch()),
    provideAnimationsAsync(),
    // PrimeNG's design tokens, rebound onto this app's own tokens.css — see
    // core/primeng-preset.ts. ripple: false matches the flat, no-elevation
    // surface the app already draws everywhere else.
    providePrimeNG({ theme: { preset: AppPreset }, ripple: false }),
  ],
};
