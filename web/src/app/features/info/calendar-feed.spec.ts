import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { FeedEvent, FeedRules } from '@shared/feed-rules';
import { ApiService } from '../../core/api.service';
import type { FeedCheck, FeedView } from '../../core/models';
import { TeamStore } from '../../core/team-store';
import { ToastService } from '../../core/toast.service';
import { today } from '../../core/dates';
import { CalendarFeed, clock } from './calendar-feed';

const ev = (title: string, date: string, extra: Partial<FeedEvent> = {}): FeedEvent => ({
  uid: `${title}-${date}`, title, description: 'Court: Court 4', location: 'Northside Fieldhouse\n200 Example Pkwy', categories: [],
  date, endDate: date, time: '18:00', endTime: '20:00', allDay: false, cancelled: false, ...extra
});
const rules: FeedRules = {
  filter: { mode: 'prefix', text: '14-1 Gold -' }, stripFilter: true, strip: [], fallback: 'event', venue: 'firstLine',
  types: [{ when: 'title', text: 'Practice', kind: 'practice' }, { when: 'allDay', kind: 'tournament' }],
  court: { from: 'description', label: 'Court' }, preset: 'sprocket'
};
const check: FeedCheck = {
  calendar: { name: 'My Calendar', prodid: 'ical.net', zone: 'America/New_York', teamZone: 'America/New_York', total: 5, from: '2030-01-07', to: '2030-02-02', warnings: [] },
  host: 'cal.example.com', masked: 'cal.example.com/…/feed/0123…abcdef.ics', preset: 'sprocket', presetLabel: 'Sprocket Sports',
  suggestions: [{ filter: { mode: 'prefix', text: '14-1 Gold -' }, count: 4 }],
  rules,
  events: [
    ev('14-1 Gold - Practice', '2030-01-07'), ev('14-1 Gold - Practice', '2030-01-14'),
    ev('14-1 Gold - Winter Showcase', '2030-02-01', { allDay: true, endDate: '2030-02-02', time: undefined, endTime: undefined, location: '' }),
    ev('14-1 Gold - Media Day', '2030-01-20'), ev('Skills Clinic', '2030-01-09')
  ]
};
const saved: FeedView = {
  connected: true, version: 1, rules, history: [{ v: 1, at: '2030-01-01T12:00:00Z', by: 'me', summary: 'Title starts with "14-1 Gold -"' }],
  source: { host: 'cal.example.com', masked: check.masked, preset: 'sprocket', presetLabel: 'Sprocket Sports', calendarName: 'My Calendar', savedAt: '2030-01-01T12:00:00Z', savedBy: 'me', lastCheck: { at: '2030-01-01T12:00:00Z', total: 5, matched: 4 },
    importedAt: null, importFrom: null, lastSync: null, lastOkAt: null, failures: 0, nextManualAt: null }
};

const imported: FeedView = {
  ...saved,
  source: { ...saved.source!, importedAt: '2030-01-02T12:00:00Z', importFrom: '2030-01-02', lastSync: { at: new Date().toISOString(), ok: true, trigger: 'job', added: 0, changed: 1, unchanged: 3, missing: 0, total: 4 }, lastOkAt: new Date().toISOString(), failures: 0, nextManualAt: null },
  runs: [{ at: new Date().toISOString(), ok: true, trigger: 'job', added: 0, changed: 1, unchanged: 3, missing: 0, total: 4, changes: [{ eid: 'fd1', title: 'Practice', date: '2030-01-14', text: 'now 8:00 AM (was 7:30 AM)' }] }]
};

function setup(view: FeedView) {
  const api = {
    feed: vi.fn(() => Promise.resolve(view)),
    checkFeed: vi.fn(() => Promise.resolve(structuredClone(check))),
    saveFeed: vi.fn(() => Promise.resolve(saved)),
    restoreFeedRules: vi.fn(), importFeed: vi.fn(), syncFeed: vi.fn(), disconnectFeed: vi.fn(() => Promise.resolve({ connected: false, version: 0, rules: null, history: [] }))
  };
  const store = {
    teamId: signal('t14'), items: () => [{ kind: 'practice', date: '2030-01-14', cancelled: false }],
    you: () => ({ sub: 'me', roles: ['admin'] }), authorName: () => '', has: () => true, refresh: vi.fn(() => Promise.resolve())
  };
  TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: api }, { provide: TeamStore, useValue: store }, { provide: ToastService, useValue: { show: vi.fn() } }] });
  const f = TestBed.createComponent(CalendarFeed);
  f.componentRef.setInput('open', true);
  return { f, api, el: f.nativeElement as HTMLElement };
}
beforeAll(() => {
  const proto = HTMLDialogElement.prototype as unknown as { showModal?: () => void; close?: () => void };
  if (typeof proto.showModal !== 'function') proto.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  if (typeof proto.close !== 'function') proto.close = function (this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); };
});
const settle = async () => { for (let i = 0; i < 3; i++) { await new Promise((r) => setTimeout(r, 0)); TestBed.tick(); } };
const text = (el: HTMLElement) => el.textContent!.replace(/\s+/g, ' ');
const button = (el: HTMLElement, name: string) => [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent!.includes(name))!;

describe('calendar feed panel', () => {
  it('checks a new link, previews it with the rules, and saves both', async () => {
    const { api, el } = setup({ connected: false, version: 0, rules: null, history: [] });
    await settle();
    const input = el.querySelector<HTMLInputElement>('input[type=url]')!;
    input.value = ' https://cal.example.com/api/calendar/feed/0123456789abcdef0123456789abcdef.ics ';
    input.dispatchEvent(new Event('input'));
    await settle();
    button(el, 'Check feed').click();
    await settle();
    expect(api.checkFeed).toHaveBeenCalledWith('t14', 'https://cal.example.com/api/calendar/feed/0123456789abcdef0123456789abcdef.ics');
    const t = text(el);
    expect(t).toContain('Detected: Sprocket Sports');
    expect(t).toContain('Left out: 1 events');
    expect([...el.querySelectorAll('.feed-stats b')].map((b) => b.textContent)).toEqual(['5', '2', '1', '1']);
    expect(t).toContain('Practice'); expect(t).toContain('6:00 PM–8:00 PM · Northside Fieldhouse · Court 4');
    expect(t).toContain('Your schedule already has 1 practices on the same dates');
    // Everything in the feed: the clinic comes in too, as an event (its title has no "Practice").
    const radios = el.querySelectorAll<HTMLInputElement>('input[name=flt]');
    radios[1].click();
    await settle();
    expect([...el.querySelectorAll('.feed-stats b')].map((b) => b.textContent)).toEqual(['5', '2', '1', '2']);
    radios[0].click();
    await settle();
    button(el, 'Save link and rules').click();
    await settle();
    expect(api.saveFeed).toHaveBeenCalledWith('t14', { url: 'https://cal.example.com/api/calendar/feed/0123456789abcdef0123456789abcdef.ics', rules });
    expect(text(el)).toContain('Link saved');
    expect(text(el)).toContain('cal.example.com/…/feed/0123…abcdef.ics');
    expect(text(el)).toContain('by you');
  });

  it('edits the rules of a saved feed without sending the link again', async () => {
    const { api, el } = setup(saved);
    await settle();
    button(el, 'Check feed and edit rules').click();
    await settle();
    expect(api.checkFeed).toHaveBeenCalledWith('t14', undefined);
    button(el, 'Remove').click(); // the "Practice" rule
    await settle();
    expect([...el.querySelectorAll('.feed-stats b')].map((b) => b.textContent)).toEqual(['5', '0', '1', '3']);
    button(el, 'Save rules').click();
    await settle();
    expect(api.saveFeed).toHaveBeenCalledWith('t14', { rules: { ...rules, types: [rules.types[1]] } });
  });

  it('imports onto the schedule, replacing hand-entered practices from today', async () => {
    const { api, el } = setup(saved);
    api.importFeed.mockResolvedValue({ run: { ok: true, added: 4 }, replaced: { practicesRemoved: 0, seriesEnded: 1, answersMoved: 2, attendanceMoved: 0 }, feed: imported });
    await settle();
    expect(text(el)).toContain('1 practice dates from today on');
    button(el, 'Import onto the schedule').click();
    await settle();
    expect(api.importFeed).toHaveBeenCalledWith('t14', today(), today());
    expect(text(el)).toContain('Healthy');
    expect(text(el)).toContain('Recent syncs');
    expect(text(el)).toContain('Practice: now 8:00 AM (was 7:30 AM)');
  });

  it('syncs now, and says when it can again', async () => {
    const { api, el } = setup(imported);
    api.syncFeed.mockResolvedValue({ run: { ok: true, added: 0, changed: 0, missing: 0 }, feed: { ...imported, source: { ...imported.source!, nextManualAt: new Date(Date.now() + 299_000).toISOString() } } });
    await settle();
    button(el, 'Sync now').click();
    await settle();
    expect(api.syncFeed).toHaveBeenCalledWith('t14');
    expect(text(el)).toContain('Sync now works again in 5 minutes');
    expect(button(el, 'Sync now').disabled).toBe(true);
  });

  it('asks before disconnecting', async () => {
    const { api, el } = setup(saved);
    await settle();
    button(el, 'Disconnect').click();
    await settle();
    expect(api.disconnectFeed).not.toHaveBeenCalled();
    button(el, 'Yes, disconnect').click();
    await settle();
    expect(api.disconnectFeed).toHaveBeenCalledWith('t14');
  });

  it('writes times the way the schedule does', () => {
    expect([clock('00:15'), clock('07:30'), clock('12:00'), clock('17:30')]).toEqual(['12:15 AM', '7:30 AM', '12:00 PM', '5:30 PM']);
  });
});
