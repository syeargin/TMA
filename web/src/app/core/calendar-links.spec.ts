import { TestBed } from '@angular/core/testing';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { authInterceptor } from './api.service';
import { AuthService } from './auth.service';
import { APP_CONFIG } from './config';
import { CalendarLinks, appUrls, countByType, lastChecked, type CalLink } from './calendar-links';
import type { ScheduleItem } from './schedule';
import { CalendarPanel } from '../features/home/calendar-panel';

const flush = () => new Promise((r) => setTimeout(r, 0));
const link = (over: Partial<CalLink> = {}): CalLink => ({ scope: 'team', teamId: 't13', types: ['practice', 'tournament', 'event'], app: 'apple', token: 'tok_123-abc', createdAt: '', updatedAt: '', lastFetchAt: null, ...over });

describe('calendar links', () => {
  it('builds each app’s link from the feed', () => {
    const u = appUrls('https://api.test/public/calendar.ics?k=abc', 'A5 13 Tom (Teem Hub)');
    expect(u.apple).toBe('webcal://api.test/public/calendar.ics?k=abc');
    expect(u.google).toBe('https://calendar.google.com/calendar/r?cid=' + encodeURIComponent('webcal://api.test/public/calendar.ics?k=abc'));
    expect(u.outlook).toContain('https://outlook.live.com/calendar/0/addfromweb?url=https%3A%2F%2Fapi.test%2Fpublic%2Fcalendar.ics%3Fk%3Dabc&name=A5%2013%20Tom');
    expect(u.office).toContain('https://outlook.office.com/calendar/0/addfromweb?url=');
  });

  it('counts upcoming dates by kind, leaving out cancelled and past ones', () => {
    const it = (kind: string, date: string, cancelled = false) => ({ key: kind + date, kind, title: '', date, end: date, time: '', location: '', note: '', cancelled }) as unknown as ScheduleItem;
    const items = [it('practice', '2026-11-03'), it('practice', '2026-11-05', true), it('practice', '2026-10-01'), it('tournament', '2026-11-14'), it('deadline', '2026-11-10'), it('event', '2026-11-20')];
    expect(countByType(items, '2026-11-01')).toEqual({ practice: 1, tournament: 1, event: 2 });
  });

  it('says when the calendar app last checked, and warns when it stopped', () => {
    const now = Date.parse('2026-11-01T12:00:00Z');
    expect(lastChecked('2026-11-01T11:20:00Z', now)).toEqual({ text: 'Last checked 40 minutes ago', stale: false });
    expect(lastChecked('2026-10-31T12:00:00Z', now).text).toBe('Last checked 24 hours ago');
    expect(lastChecked('2026-10-11T12:00:00Z', now)).toEqual({ text: 'Not checked in 3 weeks. If you removed it from your calendar, stop it here too.', stale: true });
    expect(lastChecked(null, now).stale).toBe(true);
  });

  describe('with the API', () => {
    let http: HttpTestingController;
    beforeEach(() => {
      TestBed.configureTestingModule({
        providers: [
          { provide: APP_CONFIG, useValue: { apiUrl: 'https://api.test/' } },
          { provide: AuthService, useValue: { accessToken: async () => 'tok' } },
          provideHttpClient(withInterceptors([authInterceptor])),
          provideHttpClientTesting()
        ]
      });
      http = TestBed.inject(HttpTestingController);
    });
    afterEach(() => http.verify());

    it('says where the all-teams calendar is once it’s set up', async () => {
      const f = TestBed.createComponent(CalendarPanel);
      f.componentRef.setInput('teams', [{ teamId: 't13', name: 'A5 13 Tom', roles: ['parent'] }, { teamId: 'lfc', name: 'Lakeside U12', roles: ['parent'] }, { teamId: 'x', name: 'X', roles: ['parent'] }]);
      f.detectChanges();
      await flush();
      http.expectOne('https://api.test/me/calendars').flush({ links: [link({ scope: 'all', teamId: undefined, types: undefined, teams: { t13: ['practice'], lfc: ['event'] }, app: 'google', lastFetchAt: new Date(Date.now() - 40 * 60_000).toISOString() })] });
      await flush();
      f.detectChanges();
      const toggle = (f.nativeElement as HTMLElement).querySelector('.cal-fold-btn')!;
      expect(toggle.textContent).toContain('On');
      expect(toggle.textContent).toContain('Google Calendar · 2 teams · checked 40 min ago');
      expect(toggle.textContent).toContain('Change');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
    });

    it('keeps the list in step as links are made, reset and stopped', async () => {
      const cal = TestBed.inject(CalendarLinks);
      const loading = cal.load();
      await flush();
      http.expectOne('https://api.test/me/calendars').flush({ links: [] });
      await loading;
      const saving = cal.saveTeam('t13', ['practice'], 'google');
      await flush();
      const put = http.expectOne('https://api.test/me/calendars/teams/t13');
      expect(put.request.method).toBe('PUT');
      expect(put.request.body).toEqual({ types: ['practice'], app: 'google' });
      put.flush(link({ types: ['practice'] }));
      await saving;
      expect(cal.find('team', 't13')?.types).toEqual(['practice']);
      expect(cal.feedUrl(cal.find('team', 't13')!)).toBe('https://api.test/public/calendar.ics?k=tok_123-abc');

      const resetting = cal.reset(cal.find('team', 't13')!);
      await flush();
      http.expectOne((r) => r.method === 'POST' && r.url === 'https://api.test/me/calendars/teams/t13/reset').flush(link({ token: 'new_token' }));
      await resetting;
      expect(cal.links()!.length).toBe(1);
      expect(cal.find('team', 't13')?.token).toBe('new_token');

      const stopping = cal.stop(cal.find('team', 't13')!);
      await flush();
      http.expectOne((r) => r.method === 'DELETE').flush(null);
      await stopping;
      expect(cal.links()).toEqual([]);
    });

    it('shows one calendar for all teams, everything ticked, and the links you have', async () => {
      const f = TestBed.createComponent(CalendarPanel);
      f.componentRef.setInput('teams', [{ teamId: 't13', name: 'A5 13 Tom', roles: ['parent'] }, { teamId: 'lfc', name: 'Lakeside U12', roles: ['parent'] }]);
      f.detectChanges();
      await flush();
      http.expectOne('https://api.test/me/calendars').flush({ links: [link({ lastFetchAt: new Date(Date.now() - 40 * 60_000).toISOString() })] });
      await flush();
      f.detectChanges();
      const el = f.nativeElement as HTMLElement;
      expect(el.textContent).toContain('One calendar for all your teams');
      // Closed to start: one row that says what it does.
      const toggle = el.querySelector<HTMLButtonElement>('.cal-fold-btn')!;
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(el.querySelector<HTMLElement>('#calall-body')!.hidden).toBe(true);
      expect(toggle.textContent).toContain("Both teams' dates, updating on their own");
      expect(toggle.textContent).toContain('Set up');
      toggle.click();
      f.detectChanges();
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(el.querySelector<HTMLElement>('#calall-body')!.hidden).toBe(false);
      expect(toggle.textContent).toContain('Hide');
      expect([...el.querySelectorAll<HTMLInputElement>('.cal-card input[type=checkbox]')].every((c) => c.checked)).toBe(true);
      expect(el.querySelectorAll('.cal-card .sub-kinds input').length).toBe(6);
      const row = el.querySelector('.li-cal')!;
      expect(row.textContent).toContain('A5 13 Tom');
      expect(row.textContent).toContain('Apple Calendar');
      expect(row.textContent).toContain('Last checked 40 minutes ago');
      // The link itself never shows on the page.
      expect(el.innerHTML).not.toContain('tok_123-abc');

      // Stop asks for a second tap first.
      const stop = [...row.querySelectorAll('button')].find((b) => b.textContent!.includes('Stop'))!;
      stop.click();
      f.detectChanges();
      expect(stop.textContent).toContain('Tap again');
      stop.click();
      await flush();
      http.expectOne((r) => r.method === 'DELETE' && r.url === 'https://api.test/me/calendars/teams/t13').flush(null);
      await flush();
      f.detectChanges();
      expect(el.querySelector('.li-cal')).toBeNull();
    });
  });
});
