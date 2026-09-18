import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';

import { AuthMode, AuthPage } from './auth-page';
import { AuthResult, AuthService } from '../../core/auth.service';

const OK: AuthResult = { ok: true };
const FAIL = (message: string): AuthResult => ({ ok: false, message });

class StubAuthService {
  private pendingEmail: string | null = null;

  readonly pendingSignupEmail = () => this.pendingEmail;
  readonly signIn = vi.fn<() => Promise<AuthResult>>().mockResolvedValue(OK);
  readonly signUp = vi.fn<() => Promise<AuthResult>>().mockResolvedValue(OK);
  readonly verifySignupOtp = vi.fn<() => Promise<AuthResult>>().mockResolvedValue(OK);
  readonly resendSignupOtp = vi.fn<() => Promise<AuthResult>>().mockResolvedValue(OK);

  setPendingSignupEmail(email: string): void {
    this.pendingEmail = email;
  }

  clearPendingSignupEmail(): void {
    this.pendingEmail = null;
  }
}

function activatedRoute(mode: AuthMode, returnUrl?: string) {
  return {
    snapshot: {
      data: { mode },
      queryParamMap: convertToParamMap(returnUrl ? { returnUrl } : {}),
    },
  };
}

async function render(mode: AuthMode, opts: { returnUrl?: string; pendingEmail?: string } = {}) {
  await TestBed.configureTestingModule({
    imports: [AuthPage],
    providers: [
      provideRouter([]),
      { provide: AuthService, useClass: StubAuthService },
      { provide: ActivatedRoute, useValue: activatedRoute(mode, opts.returnUrl) },
    ],
  }).compileComponents();

  const auth = TestBed.inject(AuthService) as unknown as StubAuthService;
  if (opts.pendingEmail) auth.setPendingSignupEmail(opts.pendingEmail);

  const router = TestBed.inject(Router);
  // Spied and returned as their own values, rather than asserted on via
  // `navigate`/`navigateByUrl` later — a bare method reference
  // like that is exactly what `@typescript-eslint/unbound-method` flags as a
  // potentially detached call, even inside `expect(...).toHaveBeenCalledWith`.
  const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
  const navigateByUrl = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);

  const fixture = TestBed.createComponent(AuthPage);
  fixture.detectChanges();
  await fixture.whenStable();

  return { fixture, auth, navigate, navigateByUrl, component: fixture.componentInstance };
}

describe('AuthPage — sign in', () => {
  it('rejects an empty email without calling the service', async () => {
    const { component, auth } = await render('signin');

    await component['submit']();

    expect(component['error']()).toBe('Enter your email address.');
    expect(auth.signIn).not.toHaveBeenCalled();
  });

  it('rejects a malformed email without calling the service', async () => {
    const { component, auth } = await render('signin');
    component['email'].set('not-an-email');
    component['password'].set('secret1');

    await component['submit']();

    expect(component['error']()).toBe('That email address does not look right.');
    expect(auth.signIn).not.toHaveBeenCalled();
  });

  it('rejects an empty password without calling the service', async () => {
    const { component, auth } = await render('signin');
    component['email'].set('trader@example.com');

    await component['submit']();

    expect(component['error']()).toBe('Enter your password.');
    expect(auth.signIn).not.toHaveBeenCalled();
  });

  it('signs in with trimmed credentials and lands on the default destination', async () => {
    const { component, auth, navigateByUrl } = await render('signin');
    component['email'].set('  trader@example.com  ');
    component['password'].set('secret1');

    await component['submit']();

    expect(auth.signIn).toHaveBeenCalledWith('trader@example.com', 'secret1');
    expect(component['busy']()).toBe(false);
    expect(navigateByUrl).toHaveBeenCalledWith('/app');
  });

  it('surfaces the service error and does not navigate on failure', async () => {
    const { component, auth, navigateByUrl } = await render('signin');
    auth.signIn.mockResolvedValue(FAIL('Invalid login credentials'));
    component['email'].set('trader@example.com');
    component['password'].set('wrong');

    await component['submit']();

    expect(component['error']()).toBe('Invalid login credentials');
    expect(navigateByUrl).not.toHaveBeenCalled();
  });

  it('returns a signed-in user to the page they were headed to', async () => {
    const { component, navigateByUrl } = await render('signin', { returnUrl: '/app/billing' });
    component['email'].set('trader@example.com');
    component['password'].set('secret1');

    await component['submit']();

    expect(navigateByUrl).toHaveBeenCalledWith('/app/billing');
  });

  it('ignores a protocol-relative returnUrl to avoid an open redirect', async () => {
    const { component, navigateByUrl } = await render('signin', {
      returnUrl: '//evil.example.com',
    });
    component['email'].set('trader@example.com');
    component['password'].set('secret1');

    await component['submit']();

    expect(navigateByUrl).toHaveBeenCalledWith('/app');
  });
});

describe('AuthPage — sign up', () => {
  it('rejects a password shorter than the minimum', async () => {
    const { component, auth } = await render('signup');
    component['email'].set('trader@example.com');
    component['password'].set('abc');

    await component['submit']();

    expect(component['error']()).toBe('Use at least 6 characters for your password.');
    expect(auth.signUp).not.toHaveBeenCalled();
  });

  it('parks the pending email and moves to the code step on success', async () => {
    const { component, auth, navigate } = await render('signup', { returnUrl: '/app/billing' });
    component['email'].set('trader@example.com');
    component['password'].set('secret1');

    await component['submit']();

    expect(auth.signUp).toHaveBeenCalledWith('trader@example.com', 'secret1');
    expect(navigate).toHaveBeenCalledWith(['/verify-email'], {
      queryParams: { returnUrl: '/app/billing' },
    });
  });

  it('surfaces a duplicate-account error without moving to the code step', async () => {
    const { component, auth, navigate } = await render('signup');
    auth.signUp.mockResolvedValue(FAIL('User already registered'));
    component['email'].set('trader@example.com');
    component['password'].set('secret1');

    await component['submit']();

    expect(component['error']()).toBe('User already registered');
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('AuthPage — verify email (otp)', () => {
  it('shows the recipient and starts the resend cooldown when a signup is pending', async () => {
    const { component } = await render('otp', { pendingEmail: 'trader@example.com' });

    expect(component['notice']()).toContain('trader@example.com');
    expect(component['resendIn']()).toBe(30);
  });

  it('rejects a short code without calling the service', async () => {
    const { component, auth } = await render('otp', { pendingEmail: 'trader@example.com' });
    component['otp'].set('123');

    await component['submit']();

    expect(component['error']()).toBe('Enter all 6 digits of the code.');
    expect(auth.verifySignupOtp).not.toHaveBeenCalled();
  });

  it('verifies the code, clears the pending signup, and continues on to returnUrl', async () => {
    const { component, auth, navigateByUrl } = await render('otp', {
      pendingEmail: 'trader@example.com',
      returnUrl: '/app/billing',
    });
    component['otp'].set('123456');

    await component['submit']();

    expect(auth.verifySignupOtp).toHaveBeenCalledWith('trader@example.com', '123456');
    expect(auth.pendingSignupEmail()).toBeNull();
    expect(navigateByUrl).toHaveBeenCalledWith('/app/billing');
  });

  it('keeps the pending signup and shows the error when the code is wrong', async () => {
    const { component, auth, navigateByUrl } = await render('otp', {
      pendingEmail: 'trader@example.com',
    });
    auth.verifySignupOtp.mockResolvedValue(FAIL('Token has expired or is invalid'));
    component['otp'].set('000000');

    await component['submit']();

    expect(component['error']()).toBe('Token has expired or is invalid');
    expect(auth.pendingSignupEmail()).toBe('trader@example.com');
    expect(navigateByUrl).not.toHaveBeenCalled();
  });

  it('sends a reload with nothing pending back to /signup instead of verifying', async () => {
    const { component, auth, navigate } = await render('otp');
    component['otp'].set('123456');

    await component['submit']();

    expect(auth.verifySignupOtp).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(['/signup'], { queryParams: {} });
  });

  it('resends a new code and restarts the cooldown', async () => {
    const { component, auth } = await render('otp', { pendingEmail: 'trader@example.com' });
    component['resendIn'].set(0);

    await component['resendOtp']();

    expect(auth.resendSignupOtp).toHaveBeenCalledWith('trader@example.com');
    expect(component['notice']()).toBe('Sent a new code.');
    expect(component['resendIn']()).toBe(30);
  });

  it('does nothing while the cooldown is still running', async () => {
    const { component, auth } = await render('otp', { pendingEmail: 'trader@example.com' });
    // startOtpStep already put the cooldown at 30.

    await component['resendOtp']();

    expect(auth.resendSignupOtp).not.toHaveBeenCalled();
  });
});
