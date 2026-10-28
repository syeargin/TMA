import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { MatchDoc } from '@shared/matches';
import { TeamStore } from '../../core/team-store';
import { Matches } from '../tournaments/matches';
import { Stats } from './stats';
import { seasonShare, tournamentShare } from './share-results';

beforeAll(() => {
  const proto = HTMLDialogElement.prototype as unknown as { showModal?: () => void; close?: () => void };
  if (typeof proto.showModal !== 'function') proto.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  if (typeof proto.close !== 'function') proto.close = function (this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); };
});
const text = (el: Element) => el.textContent!.replace(/\s+/g, ' ');

const fc = { eid: 'fc', kind: 'tournament', title: 'Fall Classic', date: '2026-11-14', endDate: '2026-11-15' };
const hb = { eid: 'hb', kind: 'tournament', title: 'Harvest Cup', date: '2026-10-24' };
const docs: Record<string, MatchDoc> = {
  fc: {
    slots: { '2026-11-14': 4 }, scorekeeper: 'u-mia',
    matches: {
      '2026-11-14-1': { date: '2026-11-14', n: 1, opponent: 'Lakeside 13 Gold', time: '8:00 AM', court: '6', format: 3, sets: [{ us: 25, them: 21 }, { us: 23, them: 25 }, { us: 15, them: 11 }], result: 'W' },
      '2026-11-14-2': { date: '2026-11-14', n: 2, opponent: 'Northside', format: 3, sets: [{ us: 19, them: 25 }, { us: 22, them: 25 }], result: 'L' }
    }
  },
  hb: { matches: { '2026-10-24-1': { date: '2026-10-24', n: 1, opponent: 'Lakeside 13 Gold', format: 2, sets: [{ us: 25, them: 20 }, { us: 25, them: 22 }], result: 'W' } } }
};

function fake(opts: { roles?: string[]; sub?: string; docs?: Record<string, MatchDoc> } = {}) {
  const roles = opts.roles ?? ['coach'];
  const d = opts.docs ?? docs;
  const store = {
    teamId: signal('t13'), teamName: () => 'Test 13', club: () => ({ name: 'Test Club', colors: { primary: '#15532F', accent: '#9AD3A5' } }),
    settings: () => ({ season: '2026-27' }), readOnly: () => false, has: () => true,
    can: (p: string) => p === 'scores' && roles.includes('coach'),
    you: () => ({ sub: opts.sub ?? 'u-coach', roles }),
    matches: () => d, tournaments: () => [hb, fc],
    canScore: (eid: string) => roles.includes('coach') || d[eid]?.scorekeeper === opts.sub,
    authorName: (sub?: string) => (sub === 'u-mia' ? 'Mia Stone' : ''),
    members: () => [{ sub: 'u-mia', firstName: 'Mia', lastName: 'Stone', roles: ['parent'], pid: 'p1' }, { sub: 'u-coach', firstName: 'Kim', roles: ['coach'] }],
    playerName: () => 'Ava', travelOf: () => null,
    saveMatch: vi.fn(() => Promise.resolve(true)), setMatchSlots: vi.fn(() => Promise.resolve(true)), setScorekeeper: vi.fn(() => Promise.resolve(true)), clearMatch: vi.fn(() => Promise.resolve(true))
  };
  TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: TeamStore, useValue: store }] });
  return store;
}

describe('sharing results', () => {
  it('writes a tournament and a season as text, with no times, courts or players', () => {
    const t = tournamentShare({ team: 'Test 13', club: 'Test Club', title: 'Fall Classic', when: 'Nov 14–15', totals: { played: 2, won: 1, lost: 1, setsWon: 2, setsLost: 3, pointsFor: 104, pointsAgainst: 107, toPlay: 2 },
      matches: [{ opponent: 'Lakeside 13 Gold', sets: [{ us: 25, them: 21 }, { us: 23, them: 25 }, { us: 15, them: 11 }], result: 'W' }, { opponent: 'Northside', sets: [{ us: 19, them: 25 }, { us: 22, them: 25 }], result: 'L' }] });
    expect(t.text).toBe('Test 13 at Fall Classic (Nov 14–15): 1–1, sets 2–3 · points −3\nW 25–21, 23–25, 15–11 vs Lakeside 13 Gold\nL 19–25, 22–25 vs Northside\n— Shared from Teem Hub · teemhub.net');
    expect(t.headline).toBe('1–1');
    expect(t.text).not.toMatch(/AM|Ct|court/i);
    const s = seasonShare({ team: 'Test 13', label: '2026-27 season', totals: { played: 3, won: 2, lost: 1, setsWon: 4, setsLost: 3, pointsFor: 154, pointsAgainst: 149, toPlay: 0 }, tournaments: [{ title: 'Harvest Cup', totals: { played: 1, won: 1, lost: 0, setsWon: 2, setsLost: 0, pointsFor: 50, pointsAgainst: 42, toPlay: 0 } }] });
    expect(s.text).toBe('Test 13, 2026-27 season: 2–1, sets 4–3 · points +5\nHarvest Cup: 1–0 (sets 2–0 · +8)\n— Shared from Teem Hub · teemhub.net');
  });
});

describe('a tournament\'s Matches section', () => {
  it('shows each day with 3 rows unless changed, the summary, and staff controls', () => {
    fake();
    const f = TestBed.createComponent(Matches);
    f.componentRef.setInput('event', fc);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    const days = [...el.querySelectorAll('section.card')].filter((s) => s.querySelector('.mt-table'));
    expect(days.map((d) => d.querySelectorAll('tbody tr').length)).toEqual([4, 3]);
    expect(text(days[0])).toContain('Lakeside 13 Gold');
    expect(text(el)).toContain('2 of 7 matches played');
    expect(text(el)).toContain('Mia Stone');
    expect(el.querySelectorAll('button').length).toBeGreaterThan(5);
    expect([...el.querySelectorAll('button')].some((b) => b.textContent?.includes('Add match'))).toBe(true);
  });

  it('fills in the outcome from the sets and saves only real sets', async () => {
    const store = fake();
    const f = TestBed.createComponent(Matches);
    f.componentRef.setInput('event', fc);
    f.detectChanges();
    const c = f.componentInstance;
    c.open('2026-11-14', 3);
    c.set('opponent', 'Metro');
    c.setScore(0, 'us', '25'); c.setScore(0, 'them', '23');
    c.setScore(1, 'us', '25'); c.setScore(1, 'them', '2x2');
    expect(c.outcome()).toBe('W');
    expect(c.problem()).toBe('');
    await c.save();
    expect(store.saveMatch).toHaveBeenCalledWith('fc', '2026-11-14-3', { time: '', court: '', opponent: 'Metro', format: 3, sets: [{ us: 25, them: 23 }, { us: 25, them: 22 }], result: 'W' });
  });

  it('asks for Win or Loss when 2 sets split, and flags a tied set', () => {
    fake();
    const f = TestBed.createComponent(Matches);
    f.componentRef.setInput('event', fc);
    f.detectChanges();
    const c = f.componentInstance;
    c.open('2026-11-15', 1);
    c.setFormat(2);
    c.setScore(0, 'us', '25'); c.setScore(0, 'them', '20'); c.setScore(1, 'us', '20'); c.setScore(1, 'them', '25');
    expect(c.outcome()).toBe('');
    expect(c.outcomeHint()).toMatch(/1–1: pick Win or Loss/);
    c.set('result', 'L');
    expect(c.outcome()).toBe('L');
    c.setScore(1, 'us', '25');
    expect(c.problem()).toMatch(/tied/);
  });

  it('lets the scorekeeper enter scores but not change rows or the scorekeeper; others only look', () => {
    fake({ roles: ['parent'], sub: 'u-mia' });
    const f = TestBed.createComponent(Matches);
    f.componentRef.setInput('event', fc);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(text(el)).toContain("You're the scorekeeper for this tournament");
    expect(text(el)).not.toContain('Choose a parent');
    expect([...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Remove')).toBe(false);
    TestBed.resetTestingModule();
    fake({ roles: ['parent'], sub: 'u-dan' });
    const g = TestBed.createComponent(Matches);
    g.componentRef.setInput('event', fc);
    g.detectChanges();
    expect([...(g.nativeElement as HTMLElement).querySelectorAll('button')].some((b) => /Enter score|Edit|Add match/.test(b.textContent ?? ''))).toBe(false);
  });
});

describe('the Stats tab', () => {
  it('adds up the season, lists tournaments newest first and opponents met twice', () => {
    fake();
    const f = TestBed.createComponent(Stats);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(text(el)).toContain('2–1 67%');
    expect(text(el)).toContain('2026-27 season');
    const rows = [...el.querySelectorAll('tbody tr')].map((r) => text(r));
    expect(rows[0]).toContain('Fall Classic');
    expect(rows[1]).toContain('Harvest Cup');
    expect(text(el)).toContain('Lakeside 13 Gold2–04–1');
    expect(el.querySelectorAll('.st-form span').length).toBe(3);
  });

  it('says where scores come from when there are none', () => {
    fake({ docs: {} });
    const f = TestBed.createComponent(Stats);
    f.detectChanges();
    expect(text(f.nativeElement)).toContain('No match results yet');
  });
});
