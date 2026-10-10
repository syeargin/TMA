import { googleUrl, ics, icsFileName, outlookUrl, toCalEvent, toSeriesCalEvent } from './calendar';
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
    expect(odd).toContain('SUMMARY:Dinner\\; pizza\\, salad');
    expect(odd.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    expect(icsFileName(allDay)).toBe('Winter-Classic.ics');
  });
});

describe('series calendar entries', () => {
  const series = { id: 'e9', source: 'event' as const, every: 1, days: [2, 4], until: '2026-11-19',
    dates: ['2026-11-03', '2026-11-05', '2026-11-10', '2026-11-12', '2026-11-17', '2026-11-19'],
    active: ['2026-11-03', '2026-11-05', '2026-11-12', '2026-11-17', '2026-11-19'] };
  const it9 = item({ key: 'e9-2026-11-03', title: 'Open gym', time: '6:00 PM – 8:00 PM', series });

  it('starts at the next date, repeats weekly, and lists missing dates as exceptions', () => {
    const e = toSeriesCalEvent(it9, LINK, '2026-11-04')!;
    expect(e.start!.getDate()).toBe(5);
    expect(e.rrule).toMatch(/^FREQ=WEEKLY;INTERVAL=1;BYDAY=TU,TH;UNTIL=\d{8}T\d{6}Z;WKST=SU$/);
    expect(e.exdates).toEqual(['2026-11-10']);
    expect(e.uid).toBe('event-e9@a5-team-hub');
    const file = ics(e);
    expect(file).toContain('RRULE:FREQ=WEEKLY');
    expect(file).toMatch(/EXDATE:20261110T\d{6}Z/);
    expect(new URL(googleUrl(e)).searchParams.get('recur')).toBe(`RRULE:${e.rrule}`);
  });
  it('all-day series use plain dates', () => {
    const e = toSeriesCalEvent(item({ title: 'Dues', kind: 'deadline', series: { ...series, every: 2 } }), LINK, '2026-11-01')!;
    expect(e.rrule).toContain('INTERVAL=2');
    expect(e.rrule).toContain('UNTIL=20261119;');
    expect(ics(e)).toContain('EXDATE;VALUE=DATE:20261110');
  });
  it('nothing left to add once the series is over, or for a one-time item', () => {
    expect(toSeriesCalEvent(it9, LINK, '2026-11-20')).toBeNull();
    expect(toSeriesCalEvent(item({}), LINK)).toBeNull();
  });
  it('escapes semicolons in text', () => {
    expect(ics(toCalEvent(item({ title: 'A; B' }), LINK))).toContain('SUMMARY:A\\; B');
  });
});

describe('practice details in calendar entries', () => {
  const ev = { eid: 'prs', kind: 'practice' as const, title: 'Team practice', date: '2026-11-03', time: '6:30 PM', endTime: '8:30 PM', location: 'A5 Gym', court: '3',
    uniformColor: 'Navy', repeat: { every: 1, days: [2], until: '2026-12-15' }, overrides: { '2026-11-17': { court: '5' } } };
  const series = { id: 'prs', source: 'event' as const, every: 1, days: [2], until: '2026-12-15', dates: ['2026-11-03', '2026-11-10', '2026-11-17'], active: ['2026-11-03', '2026-11-10', '2026-11-17'] };
  it('put the court in the location and the uniform in the details', () => {
    const e = toCalEvent(item({ kind: 'practice', title: 'Team practice', time: '6:30 PM – 8:30 PM', location: 'A5 Gym', court: '3', uniformColor: 'Navy' }), LINK);
    expect(e.location).toBe('A5 Gym, Court 3');
    expect(e.details).toContain('Practice uniform: Navy');
  });
  it('a whole-series entry uses the series details even from a changed date, and says some dates differ', () => {
    const e = toSeriesCalEvent(item({ kind: 'practice', title: 'Team practice', date: '2026-11-17', court: '5', edited: true, event: ev, series, time: '6:30 PM – 8:30 PM' }), LINK, '2026-11-01')!;
    expect(e.location).toBe('A5 Gym, Court 3');
    expect(e.details).toContain('One date has its own time or details');
  });
});
