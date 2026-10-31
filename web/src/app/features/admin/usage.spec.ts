import type { Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ApiService } from '../../core/api.service';
import { areaOf, deviceOf, sourceOf } from '../../core/usage.service';
import { Health } from './health';
import { Usage, niceMax } from './usage';
import type { HealthReport, UsageReport } from './usage-types';

const text = (el: Element) => el.textContent!.replace(/\s+/g, ' ');
const settle = async () => { await new Promise((r) => setTimeout(r, 0)); TestBed.tick(); };

describe('counting pages (site)', () => {
  it('names each page, with its team', () => {
    expect(areaOf('/teams/t13')).toEqual({ area: 'home', teamId: 't13' });
    expect(areaOf('/teams/t13/schedule?edit=x')).toEqual({ area: 'schedule', teamId: 't13' });
    expect(areaOf('/teams/t13/tournaments')).toEqual({ area: 'tournaments', teamId: 't13' });
    expect(areaOf('/teams/t13/tournaments/fc')).toEqual({ area: 'gameday', teamId: 't13' });
    expect(areaOf('/teams/t13/tournaments/fc/matches')).toEqual({ area: 'matches', teamId: 't13' });
    expect(areaOf('/teams/t13/roster/attendance')).toEqual({ area: 'attendance', teamId: 't13' });
    expect(areaOf('/teams/t13/info/tasks')).toEqual({ area: 'info', teamId: 't13' });
    expect(areaOf('/teams').area).toBe('teams');
    expect(areaOf('/').area).toBe('landing');
    expect(areaOf('/help/add-practice').area).toBe('help');
    expect(areaOf('/admin/usage').area).toBe('admin');
    expect(areaOf('/signin?notice=x').area).toBe('signin');
    expect(areaOf('/answer#t=abc').area).toBe('answer');
    expect(areaOf('/nowhere').area).toBe('other');
  });

  it('tells how a visit started, and what kind of device it is', () => {
    const o = 'https://teemhub.net';
    expect(sourceOf(`${o}/teams/t1?via=email`, '', false, o)).toBe('email');
    expect(sourceOf(`${o}/answer?via=email#t=1`, 'https://mail.google.com/', false, o)).toBe('email');
    expect(sourceOf(`${o}/teams`, '', true, o)).toBe('app');
    expect(sourceOf(`${o}/teams`, 'https://www.facebook.com/', false, o)).toBe('link');
    expect(sourceOf(`${o}/teams`, `${o}/signin`, false, o)).toBe('direct');
    expect(sourceOf(`${o}/teams`, '', false, o)).toBe('direct');
    const w = (coarse: boolean, width: number, height: number) => ({ matchMedia: () => ({ matches: coarse }), screen: { width, height } }) as unknown as Window;
    expect(deviceOf(w(true, 390, 844))).toBe('phone');
    expect(deviceOf(w(true, 820, 1180))).toBe('tablet');
    expect(deviceOf(w(false, 1440, 900))).toBe('computer');
  });

  it('rounds chart tops to tidy numbers', () => {
    expect(niceMax(0)).toBe(4);
    expect(niceMax(17)).toBe(20);
    expect(niceMax(214)).toBe(250);
    expect(niceMax(480)).toBe(500);
  });
});

const USAGE: UsageReport = {
  period: '30d', from: '2026-10-01', to: '2026-10-30', prevFrom: '2026-09-01', prevTo: '2026-09-30', days: 30, today: '2026-10-30', club: 'all',
  clubs: [{ clubId: 'a5', name: 'A5 Volleyball' }, { clubId: 'ns', name: 'Northside' }],
  tiles: { active7: 21, active7Family: 18, active7Staff: 3, members: 30, teamsInUse: 2, teams: 3, joined: 20, roster: 30, answeredPct: 78, needsLook: 1 },
  weekly: Array.from({ length: 12 }, (_, i) => ({ week: `2026-08-${String(9 + i).padStart(2, '0')}`, family: i, staff: 1 })),
  heat: Array.from({ length: 7 }, (_, d) => Array.from({ length: 8 }, (_, s) => (s === 6 ? 9 : d === 5 && s === 2 ? 7 : 1))),
  funnel: { roster: 30, invited: 26, joined: 20, answeredOnce: 18, active30: 16 },
  waitingInvites: { n: 4, worst: { name: 'A5 15 White', n: 3 } },
  sources: [{ id: 'email', label: 'Link in an email', n: 6 }, { id: 'text', label: 'Link in a text', n: 0 }, { id: 'app', label: 'Home-screen app', n: 2 }, { id: 'link', label: 'Link on another site', n: 0 }, { id: 'direct', label: 'Bookmark or typed in', n: 2 }],
  devices: [{ id: 'phone', n: 8 }, { id: 'tablet', n: 0 }, { id: 'computer', n: 2 }],
  teams: [
    { teamId: 'w15', name: 'A5 15 White', clubId: 'a5', clubName: 'A5 Volleyball', roster: 10, joined: 3, members: 4, active7: 1, answeredPct: 20, lastSeen: '2026-10-21', status: 'notStarted', why: 'Under half the families have joined.', opens: 4 },
    { teamId: 't13', name: 'A5 13 Tom', clubId: 'a5', clubName: 'A5 Volleyball', roster: 13, joined: 13, members: 16, active7: 15, answeredPct: 96, lastSeen: '2026-10-30', status: 'busy', why: '', opens: 220 }
  ],
  features: [{ label: 'Schedule and availability', teams: 2, of: 3, opens: 180 }, { label: 'Team info and handbook', teams: 1, of: 3, opens: 4 }],
  actions: [{ id: 'answers', label: 'Availability answers', n: 120, prev: 100 }, { id: 'payments', label: 'Payments recorded', n: 4, prev: 8 }, { id: 'shares', label: 'Results shared', n: 3, prev: 0 }]
};

const HEALTH: HealthReport = {
  period: '7d', from: '2026-10-24', to: '2026-10-30',
  requests: { total: 2000, failed: 4, failedPct: 0.2 }, pages: { phoneP95: 750, loads: 300 },
  mail: { sent: 100, delivered: 99, bounced: 1, complained: 0, deliveredPct: 99 },
  feeds: { failing: [{ teamId: 'n14', name: 'Northside 14 Blue' }] }, liveNow: 6,
  points: Array.from({ length: 168 }, (_, i) => ({ at: `2026-10-${String(24 + Math.floor(i / 24)).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}`, n: 10 + (i % 24), err: i === 100 ? 4 : 0 })),
  errors: [{ area: 'Schedule', where: 'server', n: 4, lastAt: '2026-10-28T23:10:00Z' }, { area: 'Stats', where: 'browser', n: 1, lastAt: '2026-10-29T12:00:00Z' }],
  slowest: [{ area: 'club', label: 'Club admin', p95: 3000, loads: 9 }, { area: 'schedule', label: 'Schedule', p95: 750, loads: 120 }],
  releases: [{ commit: 'abcdef1234567', at: '2026-10-29T18:10:00Z', errorsAfter: 0 }, { commit: '1234567abcdef', at: '2026-10-27T23:05:00Z', errorsAfter: 4 }]
};

function mount<T>(cmp: Type<T>, data: unknown) {
  const call = vi.fn(() => Promise.resolve(data));
  TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: ApiService, useValue: { call } }] });
  const f = TestBed.createComponent(cmp);
  f.detectChanges();
  return { f, call, el: f.nativeElement as HTMLElement };
}

describe('site admin › Usage', () => {
  it('shows the headline numbers, the weekly chart, the funnel and the teams needing a look first', async () => {
    const { f, el, call } = mount(Usage, USAGE);
    await settle(); f.detectChanges();
    expect(call).toHaveBeenCalledWith('GET', '/admin/usage?period=30d&club=all');
    const tiles = [...el.querySelectorAll('.us-tile')].map(text);
    expect(tiles[0]).toContain('21');
    expect(tiles[0]).toContain('of 30 members · 18 family, 3 staff');
    expect(tiles[2]).toContain('67%');
    expect(tiles[4]).toContain('1');
    expect(el.querySelectorAll('.us-chart rect.fam').length).toBe(12);
    expect(el.querySelector('.us-chart')!.getAttribute('aria-label')).toContain('this week (11 family, 1 staff)');
    expect(text(el)).toContain('Quietest: weekdays');
    expect(text(el)).toContain('4 invites waiting over a week, 3 on A5 15 White');
    const rows = [...el.querySelectorAll('.us-table tbody tr')].map(text);
    expect(rows[0]).toContain('A5 15 White');
    expect(rows[0]).toContain('Not started');
    expect(rows[1]).toContain('Busy');
    expect(rows[1]).toContain('Today');
    expect(text(el)).toContain('Link in an email');
    expect(text(el)).toContain('60%');
    expect(text(el)).toContain('Phones 80%');
    expect(text(el)).toContain('+20%');
    expect(text(el)).toContain('−50%');
    expect(text(el)).toContain('new');
    expect(text(el)).toContain('Totals, not trails');
  });

  it('asks again for another period or club', async () => {
    const { f, el, call } = mount(Usage, USAGE);
    await settle(); f.detectChanges();
    [...el.querySelectorAll<HTMLButtonElement>('.chip')].find((b) => b.textContent?.trim() === 'Season')!.click();
    expect(call).toHaveBeenLastCalledWith('GET', '/admin/usage?period=season&club=all');
    await settle(); f.detectChanges();
    const sel = el.querySelector<HTMLSelectElement>('#us-club')!;
    sel.value = 'ns'; sel.dispatchEvent(new Event('change'));
    expect(call).toHaveBeenLastCalledWith('GET', '/admin/usage?period=season&club=ns');
  });
});

describe('site admin › Health', () => {
  it('shows what failed, how fast pages open, email, feeds and releases', async () => {
    const { f, el, call } = mount(Health, HEALTH);
    await settle(); f.detectChanges();
    expect(call).toHaveBeenCalledWith('GET', '/admin/health?period=7d');
    const tiles = [...el.querySelectorAll('.us-tile')].map(text);
    expect(tiles[0]).toContain('0.2%');
    expect(tiles[0]).toContain('4 of 2000');
    expect(tiles[1]).toContain('0.75 s');
    expect(tiles[2]).toContain('99%');
    expect(tiles[3]).toContain('1 failing');
    expect(tiles[3]).toContain('Northside 14 Blue');
    expect(tiles[4]).toContain('6');
    expect(el.querySelectorAll('.us-chart rect.err').length).toBe(1);
    expect(el.querySelectorAll('.hl-axis span').length).toBe(7);
    expect(text(el)).toContain('On our servers');
    expect(text(el)).toContain("In people's browsers");
    expect(text(el)).toContain('Club admin');
    expect(text(el)).toContain('3 s');
    expect(text(el)).toContain('abcdef1');
    expect(el.querySelector('.us-table .pill.p-bad')?.textContent).toBe('4');
  });
});
