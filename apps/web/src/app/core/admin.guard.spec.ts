import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  RedirectCommand,
  convertToParamMap,
  provideRouter,
  type ActivatedRouteSnapshot,
  type RouterStateSnapshot,
} from '@angular/router';

import { AdminAccessService } from './admin-access.service';
import { adminGuard } from './auth.guard';
import { AuthService } from './auth.service';

const state = { url: '/app/admin' } as RouterStateSnapshot;

function routeFor(tab: string): ActivatedRouteSnapshot {
  return { paramMap: convertToParamMap({ tab }) } as ActivatedRouteSnapshot;
}

function configure(platform: 'browser' | 'server', isAdmin: boolean) {
  const access = { ensure: vi.fn().mockResolvedValue(isAdmin) };
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: AuthService, useValue: { whenRestored: vi.fn().mockResolvedValue(undefined) } },
      { provide: AdminAccessService, useValue: access },
      { provide: PLATFORM_ID, useValue: platform },
    ],
  });
  return access;
}

describe('adminGuard', () => {
  it('ignores every tab other than admin', async () => {
    const access = configure('browser', false);
    const result = await TestBed.runInInjectionContext(() => adminGuard(routeFor('history'), state));
    expect(result).toBe(true);
    expect(access.ensure).not.toHaveBeenCalled();
  });

  it('lets an admin onto the admin tab', async () => {
    configure('browser', true);
    const result = await TestBed.runInInjectionContext(() => adminGuard(routeFor('admin'), state));
    expect(result).toBe(true);
  });

  it('sends a non-admin back to the app', async () => {
    configure('browser', false);
    const result = await TestBed.runInInjectionContext(() => adminGuard(routeFor('admin'), state));
    expect(result).toBeInstanceOf(RedirectCommand);
  });

  it('lets a server render through without asking', async () => {
    const access = configure('server', false);
    const result = await TestBed.runInInjectionContext(() => adminGuard(routeFor('admin'), state));
    expect(result).toBe(true);
    expect(access.ensure).not.toHaveBeenCalled();
  });
});
