import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { DEFAULT_PLAYBOOK } from '@shared/dayplans';
import type { Meal } from '../../core/models';
import { TeamStore } from '../../core/team-store';
import { DayPlan } from './day-plan';

beforeAll(() => {
  const proto = HTMLDialogElement.prototype as unknown as { showModal?: () => void; close?: () => void };
  if (typeof proto.showModal !== 'function') proto.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  if (typeof proto.close !== 'function') proto.close = function (this: HTMLDialogElement) { this.removeAttribute('open'); };
});
const text = (el: Element) => el.textContent!.replace(/\s+/g, ' ');
const sq = { eid: 'sq', kind: 'tournament', title: 'Sunshine Qualifier', date: '2027-01-29', endDate: '2027-01-31', travel: true } as const;

function render(opts: { roles?: string[]; pid?: string; meals?: Meal[]; days?: Record<string, unknown> } = {}) {
  const roles = opts.roles ?? ['parent'];
  const store = {
    teamId: signal('t13'), playbook: () => DEFAULT_PLAYBOOK, has: () => true,
    can: (p: string) => (p === 'meals' && roles.includes('food')) || (p === 'schedule' && roles.includes('coach')),
    myPid: () => opts.pid ?? '', playerName: (pid: string) => ({ p1: 'Ava', p2: 'Mia' } as Record<string, string>)[pid] ?? '',
    players: () => [{ pid: 'p1', first: 'Ava' }, { pid: 'p2', first: 'Mia' }],
    headcount: () => ({ players: 12, coaches: 2, total: 14 }),
    dayPlans: () => ({ sq: { days: opts.days ?? {} } }),
    meals: () => opts.meals ?? [],
    setPlanDay: vi.fn(() => Promise.resolve(true)), setArrival: vi.fn(() => Promise.resolve(true)), myOrder: vi.fn(() => Promise.resolve(true)), claimMeal: vi.fn(() => Promise.resolve(true)),
    releaseMeal: vi.fn(() => Promise.resolve(true)), saveOrderLink: vi.fn(() => Promise.resolve(true)), saveMeal: vi.fn(() => Promise.resolve(true)), deleteMeal: vi.fn()
  };
  TestBed.configureTestingModule({ imports: [DayPlan], providers: [provideRouter([]), { provide: TeamStore, useValue: store }] });
  const f = TestBed.createComponent(DayPlan);
  f.componentRef.setInput('event', sq);
  f.detectChanges();
  return { f, el: f.nativeElement as HTMLElement, store };
}
const dinner: Meal = {
  eid: 'sq', mid: 'm1', meal: 'Dinner', day: '2027-01-30', style: 'delivered', fromPlan: true, familyOrders: true,
  vendor: 'DoorDash', orderBy: '2027-01-29T18:00', claimedBy: 'p1', orderLink: 'https://drd.sh/group/8kQ2', linkAt: '2027-01-25T12:00:00Z',
  orders: { p2: { state: 'added' } }
};

describe('tournament day plan', () => {
  it('shows each day by kind, and both possible plans while the wave is not posted', () => {
    const { el } = render();
    expect([...el.querySelectorAll('.dp-day')].map((d) => [...d.children].map((c) => c.textContent!.trim()).join(' '))).toEqual(['Thu Arrival', 'Fri Play day · wave TBD', 'Sat Play day · wave TBD', 'Sun Last day · wave TBD']);
    // Thursday, the day before it starts, is the arrival day: no wave needed, the plan shows at once.
    expect(text(el)).toContain('Check in at the hotel');
    (el.querySelectorAll('.dp-day')[2] as HTMLButtonElement).click();
    TestBed.tick();
    expect(text(el)).toContain("Saturday's wave isn't posted yet");
    expect(text(el)).toContain('If AM wave');
    expect(text(el)).toContain('If PM wave');
  });

  it('lets the coach drop the arrival day when the team travels that morning', () => {
    const { el, store } = render({ roles: ['coach'] });
    const off = [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent!.includes('No arrival day'))!;
    off.click();
    expect(store.setArrival).toHaveBeenCalledWith('sq', false);
  });

  it('lets the coach set the wave', async () => {
    const { el, store } = render({ roles: ['coach'] });
    (el.querySelectorAll('.dp-day')[2] as HTMLButtonElement).click();
    TestBed.tick();
    const pm = [...el.querySelectorAll<HTMLButtonElement>('.chip')].find((b) => b.textContent!.trim() === 'PM')!;
    pm.click();
    await Promise.resolve();
    expect(store.setPlanDay).toHaveBeenCalledWith('sq', '2027-01-30', { type: 'play', wave: 'pm' }, expect.stringContaining('PM wave'));
  });

  it('gives a family the group order link and asks them to mark their order', () => {
    const { el, store } = render({ pid: 'p2', meals: [dinner], days: { '2027-01-30': { type: 'play', wave: 'pm', agenda: ['Dinner at the venue'] } } });
    (el.querySelectorAll('.dp-day')[2] as HTMLButtonElement).click();
    TestBed.tick();
    expect(text(el)).toContain('Order for 14 · DoorDash');
    expect(text(el)).toContain("Ava's family");
    expect(el.querySelector<HTMLAnchorElement>('a.btn')!.href).toBe('https://drd.sh/group/8kQ2');
    // Mia's order is already in.
    expect(text(el)).toContain("✓ Mia's order added");
    const undo = [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent!.trim() === 'Undo')!;
    undo.click();
    expect(store.myOrder).toHaveBeenCalledWith(dinner, 'p2', null);
  });

  it('lets the family with the job post the link, and shows the budget', () => {
    const { el } = render({ pid: 'p1', meals: [{ ...dinner, orderLink: undefined }], days: { '2027-01-30': { type: 'play', wave: 'pm' } } });
    (el.querySelectorAll('.dp-day')[2] as HTMLButtonElement).click();
    TestBed.tick();
    expect(el.querySelector('form.dp-link')).toBeTruthy();
    expect(text(el)).toContain('14 × $20 = $280');
    expect(text(el)).toContain('Hand this job back');
  });
});
