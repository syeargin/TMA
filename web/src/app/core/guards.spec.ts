import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, Router, RouterStateSnapshot, convertToParamMap, provideRouter, type UrlTree } from '@angular/router';
import { MeService } from './me.service';
import { startGuard, startTeam } from './guards';
import type { Me, MyTeam } from './models';

const team = (teamId: string, extra: Partial<MyTeam> = {}): MyTeam => ({ teamId, roles: ['parent'], ...extra });

describe('where people land', () => {
  it('opens the one team a family is on', () => {
    expect(startTeam({ teams: [team('t13')] })).toBe('t13');
    // Archived teams don't count.
    expect(startTeam({ teams: [team('t13'), team('t12', { archived: true })] })).toBe('t13');
  });

  it('shows Your teams for two teams, none, club admins, site owners, and someone just added to a team', () => {
    expect(startTeam({ teams: [team('t13'), team('lfc')] })).toBeNull();
    expect(startTeam({ teams: [] })).toBeNull();
    expect(startTeam({ teams: [team('t13')], clubAdmin: true })).toBeNull();
    expect(startTeam({ teams: [team('t13')], platformAdmin: true })).toBeNull();
    expect(startTeam({ teams: [team('t13')], clubs: [{ clubId: 'a5', name: 'A5', short: '', colors: { primary: '', accent: '' }, links: [], notes: '', admin: true }] })).toBeNull();
    expect(startTeam({ teams: [team('t13')], acceptedInvites: 1 })).toBeNull();
  });

  describe('startGuard', () => {
    let me: Me;
    const run = (query: Record<string, string>) => {
      const route = { queryParamMap: convertToParamMap(query) } as ActivatedRouteSnapshot;
      return TestBed.runInInjectionContext(() => startGuard(route, {} as RouterStateSnapshot)) as Promise<boolean | UrlTree>;
    };
    const url = (r: boolean | UrlTree) => (typeof r === 'boolean' ? r : TestBed.inject(Router).serializeUrl(r));
    beforeEach(() => {
      TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: MeService, useValue: { load: async () => me } }] });
    });

    it('leaves Your teams alone when someone goes there on purpose', async () => {
      me = { teams: [team('t13')] };
      expect(await run({})).toBe(true);
    });

    it('sends a one-team family to their team on arrival, and everyone else to the plain list', async () => {
      me = { teams: [team('t13')] };
      expect(url(await run({ start: '1' }))).toBe('/teams/t13');
      me = { teams: [team('t13'), team('lfc')] };
      expect(url(await run({ start: '1' }))).toBe('/teams');
    });
  });
});
