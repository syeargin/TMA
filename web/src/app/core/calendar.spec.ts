import { googleUrl, ics, icsFileName, outlookUrl, toCalEvent } from './calendar';
import type { ScheduleItem } from './schedule';

const item = (o: Partial<ScheduleItem>): ScheduleItem => ({
  key: 'e1', kind: 'event', title: 'Team dinner', date: '2026-11-11', end: '2026-11-11', time: '', location: '', note: '',
  travel: false, cancelled: false, ...o
});
const LINK = 'https://hub.test/teams/ta/schedule';

describe('calendar entries', () => {
  it('practice with start and end times', () => {
    const e = toCalEvent(item({ kind: 'practice', title: 'Practice', key: 'pr-wed-2026-11-11', time: '6:30 PM – 8:30 PM', location: 'A5 Gym' }), LINK);
    expect(e.allDay).toBe(false);
    expect([e.start!.getHours(), e.start!.getMinutes(), e.end!.getHours(), e.end!.getMinutes()]).toEqual([18, 30, 20, 30]);
    expect(e.title).toBe('Practice');
    expect(toCalEvent(item({ kind: 'practice', title: 'Sunday skills', time: '1:00 PM' }), LINK).title).toBe('Sunday skills practice');
    expect(e.details).toContain(LINK);
  });
  it('event with only a start time lasts two hours', () => {
    const e = toCalEvent(item({ time: '7:00 PM' }), LINK);
    expect(e.end!.getTime() - e.start!.getTime()).toBe(2 * 3600_000);
  });
  it('tournaments, deadlines and untimed items are all-day; end date is the day after', () => {
    expect(toCalEvent(item({ kind: 'tournament', date: '2026-11-14', end: '2026-11-15', time: '' }), LINK)).toMatchObject({ allDay: true, startDate: '2026-11-14', endDate: '2026-11-16' });
    expect(toCalEvent(item({ kind: 'deadline', time: '5:00 PM' }), LINK).allDay).toBe(true);
    expect(toCalEvent(item({ kind: 'practice', time: 'Time TBD' }), LINK)).toMatchObject({ allDay: true, endDate: '2026-11-12' });
  });
});

describe('calendar links', () => {
  const timed = toCalEvent(item({ time: '7:00 PM', location: 'Pizza Place' }), LINK);
  const allDay = toCalEvent(item({ kind: 'tournament', title: 'Winter Classic', date: '2026-11-14', end: '2026-11-15' }), LINK);
  it('Google', () => {
    const u = new URL(googleUrl(timed));
    expect(u.hostname).toBe('calendar.google.com');
    expect(u.searchParams.get('text')).toBe('Team dinner');
    expect(u.searchParams.get('dates')).toMatch(/^\d{8}T\d{6}Z\/\d{8}T\d{6}Z$/);
    expect(new URL(googleUrl(allDay)).searchParams.get('dates')).toBe('20261114/20261116');
  });
  it('Outlook.com and Microsoft 365', () => {
    const live = new URL(outlookUrl(timed, 'live'));
    expect(live.hostname).toBe('outlook.live.com');
    expect(live.searchParams.get('startdt')).toMatch(/^2026-11-11T19:00:00[+-]\d{2}:\d{2}$/);
    expect(live.searchParams.get('location')).toBe('Pizza Place');
    const off = new URL(outlookUrl(allDay, 'office'));
    expect(off.hostname).toBe('outlook.office.com');
    expect([off.searchParams.get('startdt'), off.searchParams.get('enddt'), off.searchParams.get('allday')]).toEqual(['2026-11-14', '2026-11-16', 'true']);
  });
  it('.ics file for Apple and Outlook desktop', () => {
    const f = ics(allDay, new Date(Date.UTC(2026, 9, 1, 12)));
    expect(f).toContain('DTSTART;VALUE=DATE:20261114\r\nDTEND;VALUE=DATE:20261116');
    expect(f).toContain('DTSTAMP:20261001T120000Z');
    expect(f.endsWith('END:VCALENDAR\r\n')).toBe(true);
    const odd = ics(toCalEvent(item({ title: 'Dinner; pizza, salad', note: 'x'.repeat(200), time: '7:00 PM' }), LINK));
    expect(odd).toContain('SUMMARY:Dinner\; pizza\\, salad');
    expect(odd.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    expect(icsFileName(allDay)).toBe('Winter-Classic.ics');
  });
});
