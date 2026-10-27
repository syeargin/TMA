import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { HELP_TOPICS, STARTER_PICKS } from '@shared/help';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { MeService } from '../../core/me.service';
import { TeamStore } from '../../core/team-store';
import { HelpHome } from './help-home';
import { HelpSheet } from './help-sheet';
import { HelpSheetState } from './help-sheet-state';
import { HelpTopic } from './help-topic';
import { goLink, placeOf, topicById } from './help.service';

beforeAll(() => {
  const proto = HTMLDialogElement.prototype as unknown as { showModal?: () => void; close?: () => void };
  if (typeof proto.showModal !== 'function') proto.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  if (typeof proto.close !== 'function') proto.close = function (this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); };
});
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); TestBed.tick(); };
const text = (el: HTMLElement) => el.textContent!.replace(/\s+/g, ' ');

function setup(opts: { roles?: string[][]; signedIn?: boolean; popular?: Record<string, { ids: string[]; from: string }> } = {}) {
  try { localStorage.clear(); sessionStorage.clear(); } catch { /* fine */ }
  const helpEvent = vi.fn(() => Promise.resolve());
  const popular = opts.popular ?? Object.fromEntries(Object.entries(STARTER_PICKS).map(([k, ids]) => [k, { ids, from: 'starter' }]));
  const me = signal(opts.roles ? { teams: opts.roles.map((roles, i) => ({ teamId: `t${i}`, roles })) } : null);
  const user = signal(opts.signedIn || opts.roles ? { sub: 'u1', email: 'a@b.c' } : null);
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: ApiService, useValue: { helpEvent, helpPopular: () => Promise.resolve({ popular, minViews: 50 }) } },
      { provide: AuthService, useValue: { user, ensureUser: () => Promise.resolve(user()) } },
      { provide: MeService, useValue: { me, load: () => Promise.resolve(me()) } }
    ]
  });
  return { helpEvent };
}

describe('help guide', () => {
  it('lists every topic by role with Most used, and starts on your role', async () => {
    setup({ roles: [['parent']] });
    const f = TestBed.createComponent(HelpHome);
    f.detectChanges(); await settle(); f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('[aria-pressed=true]')!.textContent).toContain('Parents');
    expect(text(el.querySelector('.help-most .card-h') as HTMLElement)).toContain('by parents');
    const most = [...el.querySelectorAll('.help-most li b')].map((b) => b.textContent);
    expect(most).toEqual(STARTER_PICKS.parent.map((id) => topicById(id)!.title));
    expect(el.querySelectorAll('section.card:not(.help-most) li')).toHaveLength(8);

    (el.querySelector('.chips button') as HTMLButtonElement).click(); // Everyone
    f.detectChanges();
    expect(el.querySelectorAll('section.card:not(.help-most) li')).toHaveLength(HELP_TOPICS.length);
  });

  it('searches as you type, highlights the words and counts only whether it found anything', async () => {
    const { helpEvent } = setup();
    const f = TestBed.createComponent(HelpHome);
    f.detectChanges(); await settle();
    const el = f.nativeElement as HTMLElement;
    const input = el.querySelector('input[type=search]') as HTMLInputElement;
    input.value = 'venmo'; input.dispatchEvent(new Event('input'));
    f.detectChanges();
    expect(el.querySelector('section.card li b')!.textContent).toBe('Record a dues payment you sent');
    f.componentInstance.settle();
    expect(helpEvent).toHaveBeenCalledWith({ kind: 'search', found: true });

    input.value = 'zzzz'; input.dispatchEvent(new Event('input'));
    f.componentInstance.settle(); f.detectChanges();
    expect(text(el)).toContain('Nothing matched');
    expect(helpEvent).toHaveBeenLastCalledWith({ kind: 'search', found: false });
    for (const c of helpEvent.mock.calls as unknown as [Record<string, unknown>][]) expect(JSON.stringify(c[0])).not.toMatch(/venmo|zzzz/);

    input.value = 'hotel'; input.dispatchEvent(new Event('input'));
    f.detectChanges();
    // Other words highlight what they matched: "hotel" finds travel plans.
    expect(el.querySelector('mark')!.textContent!.toLowerCase()).toBe('travel');
  });

  it('shows a topic with its steps, counts the view once, and links to the page on your team', async () => {
    const { helpEvent } = setup({ roles: [['coach']] });
    const f = TestBed.createComponent(HelpTopic);
    f.componentRef.setInput('topic', 'add-practice');
    f.componentRef.setInput('via', 'search');
    f.componentRef.setInput('team', 'test-13');
    f.detectChanges(); await settle(); f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('h2')!.textContent).toBe('Add a practice or a repeating series');
    expect(el.querySelectorAll('.help-steps li').length).toBe(5);
    expect(el.querySelector('.help-steps b')!.textContent).toBe('Schedule');
    expect(el.querySelector('img')!.getAttribute('src')).toBe('/help-img/add-practice.webp');
    expect(el.querySelector('a.btn')!.getAttribute('href')).toBe('/teams/test-13/schedule');
    expect(text(el)).toContain('Related');
    expect(helpEvent).toHaveBeenCalledTimes(1);
    expect(helpEvent).toHaveBeenCalledWith({ kind: 'view', topic: 'add-practice', role: 'staff', via: 'search' });

    // Opening it again in the same visit doesn't count again.
    const g = TestBed.createComponent(HelpTopic);
    g.componentRef.setInput('topic', 'add-practice');
    g.detectChanges(); await settle();
    expect(helpEvent).toHaveBeenCalledTimes(1);
  });

  it('says when a topic needs a feature, and that a topic is missing', async () => {
    setup();
    const f = TestBed.createComponent(HelpTopic);
    f.componentRef.setInput('topic', 'meal-signup');
    f.detectChanges(); await settle(); f.detectChanges();
    expect(text(f.nativeElement)).toContain('Only on teams that use Tournament meals');
    f.componentRef.setInput('topic', 'nope');
    f.detectChanges();
    expect(text(f.nativeElement)).toContain("That help topic doesn't exist any more");
  });

  it('knows which page a team URL is, and where "Take me there" goes', () => {
    expect(placeOf('/teams/t13')).toBe('home');
    expect(placeOf('/teams/t13/schedule?x=1')).toBe('schedule');
    expect(placeOf('/teams/t13/tournaments')).toBe('tournaments');
    expect(placeOf('/teams/t13/tournaments/e1')).toBe('tournament');
    expect(placeOf('/teams/t13/tournaments/e1/meals')).toBe('tournament:meals');
    expect(placeOf('/teams/t13/info/tasks')).toBe('info');
    expect(placeOf('/account')).toBe('account');
    expect(placeOf('/help')).toBeNull();
    const t = topicById('record-payment')!;
    expect(goLink(t, '', false)).toEqual({ url: '/signin', label: 'Sign in to open it' });
    expect(goLink(t, '', true)).toEqual({ url: '/teams', label: 'Choose a team' });
    expect(goLink(t, 'a b', true)!.url).toBe('/teams/a%20b/fund');
    expect(goLink(topicById('join-team')!, '', true)).toEqual({ url: '/teams', label: 'Open your teams' });
    expect(goLink(topicById('post-announcement')!, 't1', true)!.url).toBe('/teams/t1');
  });
});

describe('help on a team page', () => {
  function mount(url: string, roles: string[], off: string[] = []) {
    const store = { teamId: signal('t13'), you: () => ({ roles }), has: (f: string) => !off.includes(f) };
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: TeamStore, useValue: store }] });
    const f = TestBed.createComponent(HelpSheet);
    Object.defineProperty(f.componentInstance, 'url', { value: () => url });
    TestBed.inject(HelpSheetState).open.set(true);
    f.detectChanges();
    return [...(f.nativeElement as HTMLElement).querySelectorAll('.help-list li b')].map((b) => b.textContent);
  }

  it("lists the page's topics, yours first, without features the team turned off", () => {
    expect(mount('/teams/t13/schedule', ['parent'])).toEqual([
      'Answer In, Maybe or Out', 'Add the schedule to your phone\'s calendar',
      'Add a practice or a repeating series', 'Cancel or change one date of a series', 'Take practice attendance', 'See who hasn\'t answered, and answer for a family'
    ]);
    TestBed.resetTestingModule();
    expect(mount('/teams/t13/schedule', ['coach'], ['attendance'])[0]).toBe('Add a practice or a repeating series');
    TestBed.resetTestingModule();
    expect(mount('/teams/t13/schedule', ['coach'], ['attendance'])).not.toContain('Take practice attendance');
    TestBed.resetTestingModule();
    const meals = mount('/teams/t13/tournaments/e1/meals', ['parent']);
    expect(meals[0]).toBe('Sign up to bring a meal');
    expect(meals).toContain('Find the game-day sheet');
  });
});
