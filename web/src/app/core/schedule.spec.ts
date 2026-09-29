import { addDays, daysUntil, fmtRange, tmin } from './dates';
import type { Settings, TeamEvent } from './models';
import { buildItems, countsFor, practiceKey, rsvpOf, takesRsvp } from './schedule';

describe('dates', () => {
  it('adds days across months and years', () => {
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(addDays('2027-03-01', -1)).toBe('2027-02-28');
  });
  it('counts days until a date, including across a DST change', () => {
    expect(daysUntil('2026-11-08', '2026-10-31')).toBe(8);
    expect(daysUntil('2026-10-31', '2026-10-31')).toBe(0);
  });
  it('formats ranges', () => {
    expect(fmtRange('2026-11-07')).toBe('Sat, Nov 7');
    expect(fmtRange('2026-11-07', '2026-11-08')).toBe('Nov 7–8');
    expect(fmtRange('2026-11-30', '2026-12-01')).toBe('Nov 30 – Dec 1');
  });
  it('sorts times of day', () => {
    expect(tmin('7:30 PM')).toBe(19 * 60 + 30);
    expect(tmin('12:15 PM')).toBe(12 * 60 + 15);
    expect(tmin('12:05 AM')).toBe(5);
    expect(tmin('TBD')).toBe(0);
  });
});

describe('buildItems', () => {
  const events: TeamEvent[] = [
    { eid: 'e1', kind: 'tournament', title: 'Winter Classic', date: '2026-11-14', endDate: '2026-11-15', travel: true, city: 'Columbus' },
    { eid: 'e2', kind: 'event', title: 'Team dinner', date: '2026-11-11', time: '8:00 PM', location: 'Pizza Place' },
    { eid: 'e3', kind: 'deadline', title: 'Dues due', date: '2026-11-20' }
  ];
  const settings: Settings = {
    practices: [
      { id: 'wed', label: 'Practice', dow: 3, start: '6:30 PM', end: '8:30 PM', from: '2026-11-02', until: '2026-11-25', location: 'Gym' },
      { id: 'sun', label: 'Sunday practice', dow: 0, start: '1:00 PM', from: '2026-11-08', until: '2026-11-22' },
      { id: 'nofrom', label: 'Ignored', dow: 1 }
    ],
    cancelled: [practiceKey('wed', '2026-11-18')]
  };
  const items = buildItems(events, settings);

  it('repeats each practice weekly from its first date on its day', () => {
    const wed = items.filter((i) => i.practice?.id === 'wed').map((i) => i.date);
    expect(wed).toEqual(['2026-11-04', '2026-11-11', '2026-11-18', '2026-11-25']);
    expect(items.find((i) => i.practice?.id === 'wed')!.time).toBe('6:30 PM – 8:30 PM');
  });
  it('skips practices on tournament days', () => {
    const sun = items.filter((i) => i.practice?.id === 'sun').map((i) => i.date);
    expect(sun).toEqual(['2026-11-08', '2026-11-22']); // Nov 15 is the tournament
  });
  it('marks cancelled dates and ignores practices without a first date', () => {
    expect(items.find((i) => i.key === 'pr-wed-2026-11-18')!.cancelled).toBe(true);
    expect(items.some((i) => i.practice?.id === 'nofrom')).toBe(false);
  });
  it('sorts by date, then time', () => {
    const nov11 = items.filter((i) => i.date === '2026-11-11').map((i) => i.title);
    expect(nov11).toEqual(['Practice', 'Team dinner']);
    const dates = items.map((i) => i.date);
    expect([...dates].sort()).toEqual(dates);
  });
  it('keeps tournament ranges and details', () => {
    const t = items.find((i) => i.key === 'e1')!;
    expect(t).toMatchObject({ kind: 'tournament', end: '2026-11-15', travel: true, location: 'Columbus' });
    expect(takesRsvp(t)).toBe(true);
    expect(takesRsvp(items.find((i) => i.key === 'e3')!)).toBe(false);
  });
  it('handles a team with no settings', () => {
    expect(buildItems(events, null)).toHaveLength(3);
  });
});

describe('availability', () => {
  const players = [{ pid: 'p1', first: 'Ava' }, { pid: 'p2', first: 'Bea' }, { pid: 'p3', first: 'Cy' }];
  const family = { p1: { rsvp: { e1: { v: 'yes' as const } } }, p2: { rsvp: { e1: { v: 'no' as const } } } };
  it('reads answers and counts them', () => {
    expect(rsvpOf(family, 'p1', 'e1')).toBe('yes');
    expect(rsvpOf(family, 'p3', 'e1')).toBe('');
    expect(countsFor(players, family, 'e1')).toEqual({ yes: 1, maybe: 0, no: 1, none: 1 });
  });
});
