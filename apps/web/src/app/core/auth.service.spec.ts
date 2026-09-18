import { TestBed } from '@angular/core/testing';
import type { Session } from '@supabase/supabase-js';

import { AuthService } from './auth.service';
import { SupabaseClientService } from './supabase-client';
import { environment } from '../../environments/environment';

function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    expires_at: Math.floor(Date.now() / 1000) + 3_600,
    user: { id: 'u1' },
    ...overrides,
  } as Session;
}

/** A minimal stand-in for the supabase-js client's `auth` namespace. */
function fakeClient(session: Session | null) {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session } }),
      onAuthStateChange: vi.fn(),
      signInWithPassword: vi.fn().mockResolvedValue({ error: null }),
      signUp: vi.fn().mockResolvedValue({ error: null }),
      verifyOtp: vi.fn().mockResolvedValue({ error: null }),
      resend: vi.fn().mockResolvedValue({ error: null }),
      resetPasswordForEmail: vi.fn().mockResolvedValue({ error: null }),
      updateUser: vi.fn().mockResolvedValue({ error: null }),
      signOut: vi.fn().mockResolvedValue({ error: null }),
      refreshSession: vi.fn(),
    },
  };
}

function configure(client: ReturnType<typeof fakeClient> | null) {
  TestBed.configureTestingModule({
    providers: [
      { provide: SupabaseClientService, useValue: { client, isBrowser: client !== null } },
    ],
  });
  return TestBed.inject(AuthService);
}

describe('AuthService — server (no browser client)', () => {
  it('reports restored immediately with a null session, without touching Supabase', () => {
    const auth = configure(null);

    expect(auth.restored()).toBe(true);
    expect(auth.session()).toBeNull();
  });

  it('rejects every mutating call as not available', async () => {
    const auth = configure(null);

    await expect(auth.signIn('a@b.com', 'pw')).resolves.toEqual({
      ok: false,
      message: 'Not available on the server.',
    });
    await expect(auth.getAccessToken()).resolves.toBeNull();
  });
});

describe('AuthService — browser restoration', () => {
  it('restores the persisted session and flips restored() once it resolves', async () => {
    const session = fakeSession();
    const client = fakeClient(session);
    const auth = configure(client);

    expect(auth.restored()).toBe(false);
    await auth.whenRestored();

    expect(auth.restored()).toBe(true);
    expect(auth.session()).toEqual(session);
    expect(auth.user()).toEqual(session.user);
  });

  it('falls back to a null session if getSession rejects', async () => {
    const client = fakeClient(null);
    client.auth.getSession.mockRejectedValue(new Error('network down'));
    const auth = configure(client);

    await auth.whenRestored();

    expect(auth.restored()).toBe(true);
    expect(auth.session()).toBeNull();
  });

  it('applies onAuthStateChange updates as they arrive', async () => {
    const client = fakeClient(null);
    const auth = configure(client);
    await auth.whenRestored();

    const [handler] = client.auth.onAuthStateChange.mock.calls[0] as [
      (event: unknown, session: Session | null) => void,
    ];
    const newSession = fakeSession();
    handler('SIGNED_IN', newSession);

    expect(auth.session()).toEqual(newSession);
  });
});

describe('AuthService — getAccessToken', () => {
  it('returns null when there is no session', async () => {
    const client = fakeClient(null);
    const auth = configure(client);

    expect(await auth.getAccessToken()).toBeNull();
  });

  it('returns the cached token when it has not expired', async () => {
    const session = fakeSession({ expires_at: Math.floor(Date.now() / 1000) + 3_600 });
    const client = fakeClient(session);
    const auth = configure(client);

    expect(await auth.getAccessToken()).toBe('access-token');
    expect(client.auth.refreshSession).not.toHaveBeenCalled();
  });

  it('refreshes an expired token and returns the new one', async () => {
    const session = fakeSession({ expires_at: Math.floor(Date.now() / 1000) - 10 });
    const client = fakeClient(session);
    const refreshed = fakeSession({ access_token: 'new-access-token' });
    client.auth.refreshSession.mockResolvedValue({ data: { session: refreshed }, error: null });
    const auth = configure(client);

    const token = await auth.getAccessToken();

    expect(token).toBe('new-access-token');
    expect(auth.session()).toEqual(refreshed);
  });

  it('signs the user out locally when the refresh itself fails', async () => {
    const session = fakeSession({ expires_at: Math.floor(Date.now() / 1000) - 10 });
    const client = fakeClient(session);
    client.auth.refreshSession.mockResolvedValue({
      data: { session: null },
      error: { message: 'refresh token expired' },
    });
    const auth = configure(client);

    const token = await auth.getAccessToken();

    expect(token).toBeNull();
    expect(auth.session()).toBeNull();
  });
});

describe('AuthService — sign-up disposable-domain fast path', () => {
  const originalProduction = environment.production;

  afterEach(() => {
    environment.production = originalProduction;
  });

  it('rejects a disposable-domain address before calling Supabase, in production', async () => {
    environment.production = true;
    const client = fakeClient(null);
    const auth = configure(client);

    const result = await auth.signUp('someone@mailinator.com', 'secret1');

    expect(result).toEqual({
      ok: false,
      message:
        'Please sign up with a permanent email address — temporary and disposable email providers are not accepted.',
    });
    expect(client.auth.signUp).not.toHaveBeenCalled();
  });

  it('lets a disposable-domain address through outside production, for local dev', async () => {
    environment.production = false;
    const client = fakeClient(null);
    const auth = configure(client);

    const result = await auth.signUp('someone@mailinator.com', 'secret1');

    expect(result).toEqual({ ok: true });
    expect(client.auth.signUp).toHaveBeenCalled();
  });

  it('lets a normal address through to Supabase regardless of environment', async () => {
    environment.production = true;
    const client = fakeClient(null);
    const auth = configure(client);

    const result = await auth.signUp('trader@example.com', 'secret1');

    expect(result).toEqual({ ok: true });
    expect(client.auth.signUp).toHaveBeenCalledWith({
      email: 'trader@example.com',
      password: 'secret1',
    });
  });
});

describe('AuthService — mutating calls report Supabase errors as values', () => {
  it('signIn', async () => {
    const client = fakeClient(null);
    client.auth.signInWithPassword.mockResolvedValue({
      error: { message: 'Invalid login credentials' },
    });
    const auth = configure(client);

    await expect(auth.signIn('trader@example.com', 'wrong')).resolves.toEqual({
      ok: false,
      message: 'Invalid login credentials',
    });
  });

  it('signOut', async () => {
    const client = fakeClient(null);
    const auth = configure(client);

    await expect(auth.signOut()).resolves.toEqual({ ok: true });
    expect(client.auth.signOut).toHaveBeenCalled();
  });
});
