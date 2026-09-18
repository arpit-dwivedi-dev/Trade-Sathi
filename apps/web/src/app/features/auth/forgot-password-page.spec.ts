import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { ForgotPasswordPage } from './forgot-password-page';
import { AuthResult, AuthService } from '../../core/auth.service';

class StubAuthService {
  readonly requestPasswordReset = vi
    .fn<() => Promise<AuthResult>>()
    .mockResolvedValue({ ok: true });
}

async function render() {
  await TestBed.configureTestingModule({
    imports: [ForgotPasswordPage],
    providers: [provideRouter([]), { provide: AuthService, useClass: StubAuthService }],
  }).compileComponents();

  const auth = TestBed.inject(AuthService) as unknown as StubAuthService;
  const fixture = TestBed.createComponent(ForgotPasswordPage);
  fixture.detectChanges();
  await fixture.whenStable();

  return { fixture, auth, component: fixture.componentInstance };
}

describe('ForgotPasswordPage', () => {
  it('sends the reset email and flips to the sent state', async () => {
    const { component, auth } = await render();
    component['email'].set('trader@example.com');

    await component['submit']();

    expect(auth.requestPasswordReset).toHaveBeenCalledWith('trader@example.com');
    expect(component['sent']()).toBe(true);
    expect(component['busy']()).toBe(false);
  });

  it('shows the service error and stays on the form when the send fails', async () => {
    const { component, auth } = await render();
    auth.requestPasswordReset.mockResolvedValue({ ok: false, message: 'Too many requests' });
    component['email'].set('trader@example.com');

    await component['submit']();

    expect(component['error']()).toBe('Too many requests');
    expect(component['sent']()).toBe(false);
  });
});
