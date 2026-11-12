import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { MatchDoc } from '@shared/matches';
import { TeamStore } from '../../core/team-store';
import { Matches } from './matches';
import { RefJobs } from './ref-jobs';

beforeAll(() => {
  const proto = HTMLDialogElement.prototype as unknown as { showModal?: () => void; close?: () => void };
  if (typeof proto.showModal !== 'function') proto.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  if (typeof proto.close !== 'function') proto.close = function (this: HTMLDialogElement) { this.removeAttribute('open'); };
});
const text = (el: Element) => el.textContent!.replace(/\s+/g, ' ');
const wc = { eid: 'wc', kind: 'tournament', title: 'Winter Classic', date: '2026-12-12' };
const doc: MatchDoc = {
  slots: { '2026-12-12': 2 },
  matches: { '2026-12-12-1': { date: '2026-12-12', n: 1, time: '9:00 AM', court: '6', opponent: 'Metro 13 Black', format: 2, sets: [], result: '' } },
  work: { w1: { id: 'w1', date: '2026-12-12', time: '8:00 AM', court: '6', matchNo: '1', teams: ['Lakeside 13 Gold', 'Coastal 13 Red'], group: 'A', auto: true, jobs: { p1: { s1: 'Book', s2: 'Score', s3: 'Lines' } } } }
};

function fake(roles: string[]) {
  const store = {
    teamId: signal('t13'), teamName: () => 'Test 13', club: () => null, readOnly: () => false, has: () => true,
    can: (p: string) => (p === 'scores' || p === 'refjobs') && roles.includes('coach'),
    you: () => ({ sub: 'u', roles, pid: 'p1' }), matches: () => ({ wc: doc }), tournaments: () => [wc],
    canScore: () => roles.includes('coach'), authorName: () => '', members: () => [],
    players: () => [{ pid: 'p1', first: 'Ava' }, { pid: 'p2', first: 'Bea', refTeam: 'B' }],
    playerName: (pid: string) => (pid === 'p1' ? 'Ava' : 'Bea'), travelOf: () => null, refjobs: () => ({}),
    saveWork: vi.fn(() => Promise.resolve(true)), deleteWork: vi.fn(() => Promise.resolve(true)), saveWorkJobs: vi.fn(() => Promise.resolve(true)),
    setMatchSlots: vi.fn(() => Promise.resolve(true)), saveMatch: vi.fn(() => Promise.resolve(true)), setRefGroups: vi.fn(), saveRefJobs: vi.fn()
  };
  TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: TeamStore, useValue: store }] });
  return store;
}

describe('matches the team works', () => {
  it('lists playing and working matches in time order, with the group on duty', () => {
    fake(['coach']);
    const f = TestBed.createComponent(Matches);
    f.componentRef.setInput('event', wc);
    f.detectChanges();
    const rows = [...(f.nativeElement as HTMLElement).querySelectorAll('.mt-table tbody tr')].map(text);
    expect(rows[0]).toContain('Lakeside 13 Gold v Coastal 13 Red');
    expect(rows[0]).toContain('We work');
    expect(rows[0]).toContain('Group A');
    expect(rows[0]).toContain('Set 1: Book Ava');
    expect(rows[1]).toContain('Metro 13 Black');
    expect(rows[1]).toContain('We play');
    expect(text(f.nativeElement)).toContain('The next one goes to Group B');
  });

  it('adds a match the team works, leaving the group to auto', async () => {
    const store = fake(['coach']);
    const f = TestBed.createComponent(Matches);
    f.componentRef.setInput('event', wc);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent!.trim() === 'Add match')!.click();
    f.detectChanges();
    const set = (id: string, v: string) => { const i = el.querySelector<HTMLInputElement>('#' + id)!; i.value = v; i.dispatchEvent(new Event('input')); };
    set('mt-w-a', 'Riverside'); set('mt-w-b', 'Harbor'); set('mt-w-time', '1:00 PM'); set('mt-w-court', '3');
    f.detectChanges();
    [...el.querySelectorAll<HTMLButtonElement>('button[type=submit]')].find((b) => b.textContent!.includes('Add match'))!.click();
    await Promise.resolve();
    expect(store.saveWork).toHaveBeenCalledWith('wc', 'new', { date: '2026-12-12', teams: ['Riverside', 'Harbor'], time: '1:00 PM', court: '3', matchNo: undefined, group: null }, expect.any(String));
  });

  it("shows each working match's jobs on Ref jobs, read-only for families", () => {
    fake(['parent']);
    const f = TestBed.createComponent(RefJobs);
    f.componentRef.setInput('event', wc);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(text(el)).toContain('Match 1 · Lakeside 13 Gold v Coastal 13 Red');
    expect(text(el)).toContain('Ava Book Score Lines');
    expect(text(el)).not.toContain('Bea');
    expect(el.querySelector('select')).toBeNull();
  });
});
