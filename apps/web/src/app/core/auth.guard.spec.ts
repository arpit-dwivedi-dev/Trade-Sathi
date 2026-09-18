import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  Router,
  provideRouter,
  type ActivatedRouteSnapshot,
  type RouterStateSnapshot,
} from '@angular/router';
import type { Session } from '@supabase/supabase-js';

import { authGuard, guestGuard, pendingSignupGuard } from './auth.guard';
import { AuthService } from './auth.service';

const FAKE_SESSION = {} as Session;

/**
 * Stands in for AuthService's session/pendingSignupEmail signals and its
 * restoration promise, without touching Supabase or browser storage.
 */
class StubAuthService {
  private sessionValue: Session | null = null;
  private pendingEmailValue: string | null = null;

  readonly whenRestored = vi.fn().mockResolvedValue(undefined);
  readonly session = () => this.sessionValue;
  readonly pendingSignupEmail = () => this.pendingEmailValue;

  setSession(session: Session | null): void {
    this.sessionValue = session;
  }

  setPendingSignupEmail(email: string | null): void {
    this.pendingEmailValue = email;
  }
}

const route = {} as ActivatedRouteSnapshot;
const state = { url: '/app/workspace' } as RouterStateSnapshot;

function configure(platform: 'browser' | 'server') {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: AuthService, useClass: StubAuthService },
      { provide: PLATFORM_ID, useValue: platform },
    ],
  });
}

describe('authGuard', () => {
  it('lets a server-side render through without checking the session', async () => {
    configure('server');
    const auth = TestBed.inject(AuthService) as unknown as StubAuthService;

    const result = await TestBed.runInInjectionContext(() => authGuard(route, state));

    expect(result).toBe(true);
    expect(auth.whenRestored).not.toHaveBeenCalled();
  });

  it('allows a signed-in user through in the browser', async () => {
    configure('browser');
    const auth = TestBed.inject(AuthService) as unknown as StubAuthService;
    auth.setSession(FAKE_SESSION);

    const result = await TestBed.runInInjectionContext(() => authGuard(route, state));

    expect(result).toBe(true);
    expect(auth.whenRestored).toHaveBeenCalled();
  });

  it('redirects a signed-out user to /login, carrying the attempted URL', async () => {
    configure('browser');

    const result = await TestBed.runInInjectionContext(() => authGuard(route, state));

    const router = TestBed.inject(Router);
    expect(router.serializeUrl(result as never)).toBe('/login?returnUrl=%2Fapp%2Fworkspace');
  });
});

describe('guestGuard', () => {
  it('lets a server-side render through without checking the session', async () => {
    configure('server');
    const auth = TestBed.inject(AuthService) as unknown as StubAuthService;

    const result = await TestBed.runInInjectionContext(() => guestGuard(route, state));

    expect(result).toBe(true);
    expect(auth.whenRestored).not.toHaveBeenCalled();
  });

  it('allows a signed-out user to reach the guest-only route', async () => {
    configure('browser');

    const result = await TestBed.runInInjectionContext(() => guestGuard(route, state));

    expect(result).toBe(true);
  });

  it('bounces an already signed-in user away to /app', async () => {
    configure('browser');
    const auth = TestBed.inject(AuthService) as unknown as StubAuthService;
    auth.setSession(FAKE_SESSION);

    const result = await TestBed.runInInjectionContext(() => guestGuard(route, state));

    const router = TestBed.inject(Router);
    expect(router.serializeUrl(result as never)).toBe('/app');
  });
});

describe('pendingSignupGuard', () => {
  it('lets a server-side render through without checking pending state', async () => {
    configure('server');
    const auth = TestBed.inject(AuthService) as unknown as StubAuthService;

    const result = await TestBed.runInInjectionContext(() => pendingSignupGuard(route, state));

    expect(result).toBe(true);
    expect(auth.whenRestored).not.toHaveBeenCalled();
  });

  it('allows the code step when a signup is pending', async () => {
    configure('browser');
    const auth = TestBed.inject(AuthService) as unknown as StubAuthService;
    auth.setPendingSignupEmail('trader@example.com');

    const result = await TestBed.runInInjectionContext(() => pendingSignupGuard(route, state));

    expect(result).toBe(true);
  });

  it('sends a direct visit with nothing pending back to /signup', async () => {
    configure('browser');

    const result = await TestBed.runInInjectionContext(() => pendingSignupGuard(route, state));

    const router = TestBed.inject(Router);
    expect(router.serializeUrl(result as never)).toBe('/signup');
  });
});
