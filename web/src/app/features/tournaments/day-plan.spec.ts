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

function render(opts: { roles?: string[]; pid?: string; meals?: Meal[]; days?: Record<string, unknown>; matches?: Record<string, unknown> } = {}) {
  const roles = opts.roles ?? ['parent'];
  const store = {
    teamId: signal('t13'), playbook: () => DEFAULT_PLAYBOOK, has: () => true,
    can: (p: string) => (p === 'meals' && roles.includes('food')) || (p === 'schedule' && roles.includes('coach')),
    myPid: () => opts.pid ?? '', playerName: (pid: string) => ({ p1: 'Ava', p2: 'Mia' } as Record<string, string>)[pid] ?? '',
    players: () => [{ pid: 'p1', first: 'Ava' }, { pid: 'p2', first: 'Mia' }],
    headcount: () => ({ players: 12, coaches: 2, total: 14 }), authorName: (s: string) => (s === 'u-kim' ? 'Coach Kim' : ''),
    matches: () => opts.matches ?? {}, addPlanItem: vi.fn(() => Promise.resolve(true)), savePlanItem: vi.fn(() => Promise.resolve(true)), deletePlanItem: vi.fn(() => Promise.resolve(true)),
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

  it('shows one timeline in time order, with the first match from Matches', () => {
    const { el } = render({
      meals: [{ ...dinner, time: '5:30 PM' }],
      matches: { sq: { slots: { '2027-01-30': 3 }, matches: { a: { date: '2027-01-30', n: 1, time: '3:00 PM', court: '6', opponent: 'Coastal 13 Red', format: 3, sets: [] } } } },
      days: { '2027-01-30': { type: 'play', wave: 'pm', agenda: [
        { id: 'a1', what: 'Team photo', time: '7:30 PM', where: 'Hall C entrance', by: 'u-kim', cal: true },
        { id: 'a2', what: 'Meet in the hotel lobby', time: '1:15 PM', fromPlan: true },
        { id: 'a3', what: 'Dinner at the venue', fromPlan: true, removed: true }
      ] } }
    });
    (el.querySelectorAll('.dp-day')[2] as HTMLButtonElement).click();
    TestBed.tick();
    const rows = [...el.querySelectorAll('.dp-row')].map((r) => text(r));
    const times = [...el.querySelectorAll('.dp-row .dp-t')].map((t) => t.textContent!.trim());
    expect(times).toEqual(['Any time', '1:15 PM', '3:00 PM', '5:30 PM', '7:30 PM']);
    expect(rows[1]).toContain('Meet in the hotel lobby');
    expect(rows[2]).toContain('vs Coastal 13 Red · Court 6');
    expect(rows[2]).toContain('3 matches today');
    expect(rows[4]).toContain('Added by Coach Kim');
    expect(rows.join(' ')).not.toContain('Dinner at the venue');
  });

  it('adds an item to the day; the calendar box starts unticked', async () => {
    const { el, store } = render({ roles: ['coach'], days: { '2027-01-30': { type: 'play', wave: 'pm', agenda: [] } } });
    (el.querySelectorAll('.dp-day')[2] as HTMLButtonElement).click();
    TestBed.tick();
    [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent!.trim() === 'Add to the day')!.click();
    TestBed.tick();
    const set = (id: string, v: string) => { const i = el.querySelector<HTMLInputElement>('#' + id)!; i.value = v; i.dispatchEvent(new Event('input')); };
    expect(el.querySelector<HTMLInputElement>('#dp-it-cal')!.checked).toBe(false);
    set('dp-it-time', '7:30 PM'); set('dp-it-what', 'Team photo'); set('dp-it-where', 'Hall C entrance');
    el.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit'));
    await Promise.resolve();
    expect(store.addPlanItem).toHaveBeenCalledWith('sq', '2027-01-30', { what: 'Team photo', time: '7:30 PM', where: 'Hall C entrance', note: undefined, cal: false });
  });

  it('asks before changing the wave once a day has things added by hand', async () => {
    const { el, store } = render({ roles: ['coach'], days: { '2027-01-30': { type: 'play', wave: 'pm', agenda: [{ id: 'a1', what: 'Team photo', time: '7:30 PM', by: 'u-kim' }] } } });
    (el.querySelectorAll('.dp-day')[2] as HTMLButtonElement).click();
    TestBed.tick();
    [...el.querySelectorAll<HTMLButtonElement>('.chip')].find((b) => b.textContent!.trim() === 'AM')!.click();
    TestBed.tick();
    expect(store.setPlanDay).not.toHaveBeenCalled();
    expect(text(el)).toContain('Kept: Team photo · 7:30 PM');
    [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent!.trim() === 'Change it')!.click();
    await Promise.resolve();
    expect(store.setPlanDay).toHaveBeenCalledWith('sq', '2027-01-30', { type: 'play', wave: 'am' }, expect.any(String));
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
