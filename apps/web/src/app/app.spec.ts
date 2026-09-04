import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { App } from './app';
import { routes } from './app.routes';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      // The shell is a bare <router-outlet>, so it cannot be created without a
      // router configured.
      providers: [provideRouter(routes)],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);

    expect(fixture.componentInstance).toBeTruthy();
  });

  it('renders a router outlet for the active route', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;

    // The shell owns no chrome of its own — every page is a routed component —
    // so the outlet's presence is the whole contract.
    expect(compiled.querySelector('router-outlet')).not.toBeNull();
  });
});

describe('routes', () => {
  it('sends an unknown path back to the landing page instead of nowhere', () => {
    // Without a catch-all the router matched nothing for a mistyped URL and
    // left a blank page behind.
    const wildcard = routes.find((route) => route.path === '**');

    expect(wildcard).toBeDefined();
    expect(wildcard?.redirectTo).toBe('');
  });

  it('keeps the catch-all last, so it cannot shadow a real route', () => {
    expect(routes[routes.length - 1]?.path).toBe('**');
  });

  it('guards every route that needs a session', () => {
    const guarded = routes
      .filter((route) => route.canActivate?.length)
      .map((route) => route.path);

    expect(guarded).toContain('app');
    // Signed-in users are bounced away from these rather than shown a second
    // sign-in form.
    expect(guarded).toContain('login');
    expect(guarded).toContain('forgot-password');
  });
});
