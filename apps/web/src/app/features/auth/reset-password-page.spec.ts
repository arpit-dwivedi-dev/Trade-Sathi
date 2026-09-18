import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import type { Session } from '@supabase/supabase-js';

import { ResetPasswordPage } from './reset-password-page';
import { AuthResult, AuthService } from '../../core/auth.service';
import { SupabaseClientService } from '../../core/supabase-client';

const FAKE_SESSION = {} as Session;

class StubAuthService {
  private sessionValue: Session | null = null;

  readonly whenRestored = vi.fn().mockResolvedValue(undefined);
  readonly session = () => this.sessionValue;
  readonly updatePassword = vi.fn<() => Promise<AuthResult>>().mockResolvedValue({ ok: true });

  setSession(session: Session | null): void {
    this.sessionValue = session;
  }
}

async function render({ isBrowser = true, session = null as Session | null } = {}) {
  await TestBed.configureTestingModule({
    imports: [ResetPasswordPage],
    providers: [
      provideRouter([]),
      { provide: AuthService, useClass: StubAuthService },
      { provide: SupabaseClientService, useValue: { isBrowser } },
    ],
  }).compileComponents();

  const auth = TestBed.inject(AuthService) as unknown as StubAuthService;
  auth.setSession(session);

  const router = TestBed.inject(Router);
  // Returned as its own value rather than asserted on via `router.navigateByUrl`
  // later — see the matching note in auth-page.spec.ts's render().
  const navigateByUrl = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);

  const fixture = TestBed.createComponent(ResetPasswordPage);
  fixture.detectChanges();
  await fixture.whenStable();

  return { fixture, auth, navigateByUrl, component: fixture.componentInstance };
}

describe('ResetPasswordPage', () => {
  afterEach(() => {
    window.location.hash = '';
  });

  it('marks itself ready once the recovery link produced a session', async () => {
    const { component } = await render({ session: FAKE_SESSION });

    expect(component['ready']()).toBe(true);
  });

  it('marks itself not ready when restoration finishes with no session', async () => {
    const { component } = await render({ session: null });

    expect(component['ready']()).toBe(false);
  });

  it('reads an expired/used link error straight out of the URL fragment', async () => {
    window.location.hash = '#error_description=Link%20has%20expired';

    const { component, auth } = await render({ session: FAKE_SESSION });

    expect(component['ready']()).toBe(false);
    expect(component['error']()).toBe('Link has expired');
    // Never worth restoring a session for a link the fragment already says failed.
    expect(auth.whenRestored).not.toHaveBeenCalled();
  });

  it('does nothing on the server, where there is no URL fragment to read', async () => {
    const { component, auth } = await render({ isBrowser: false });

    expect(component['ready']()).toBeNull();
    expect(auth.whenRestored).not.toHaveBeenCalled();
  });

  it('rejects mismatched passwords without calling the service', async () => {
    const { component, auth } = await render({ session: FAKE_SESSION });
    component['password'].set('secret1');
    component['confirm'].set('secret2');

    await component['submit']();

    expect(component['error']()).toBe('The two passwords do not match.');
    expect(auth.updatePassword).not.toHaveBeenCalled();
  });

  it('updates the password and lands in the app on success', async () => {
    const { component, auth, navigateByUrl } = await render({ session: FAKE_SESSION });
    component['password'].set('secret1');
    component['confirm'].set('secret1');

    await component['submit']();

    expect(auth.updatePassword).toHaveBeenCalledWith('secret1');
    expect(navigateByUrl).toHaveBeenCalledWith('/app');
  });

  it('surfaces the service error without navigating on failure', async () => {
    const { component, auth, navigateByUrl } = await render({ session: FAKE_SESSION });
    auth.updatePassword.mockResolvedValue({ ok: false, message: 'Session expired' });
    component['password'].set('secret1');
    component['confirm'].set('secret1');

    await component['submit']();

    expect(component['error']()).toBe('Session expired');
    expect(navigateByUrl).not.toHaveBeenCalled();
  });
});
