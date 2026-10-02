import type { TeamEvent } from './models';
import { describe as label, expandPattern, findPatterns } from './series';

const ev = (eid: string, date: string, o: Partial<TeamEvent> = {}): TeamEvent =>
  ({ eid, kind: 'event', title: 'Open gym', date, time: '6:00 PM', location: 'A5 Gym', ...o }) as TeamEvent;

describe('expandPattern', () => {
  it('weekly on two days', () => {
    expect(expandPattern('2026-11-03', '2026-11-13', [2, 4])).toEqual(['2026-11-03', '2026-11-05', '2026-11-10', '2026-11-12']);
  });
  it('every other week counts weeks from the start date’s week', () => {
    expect(expandPattern('2026-11-04', '2026-12-03', [3], 2)).toEqual(['2026-11-04', '2026-11-18', '2026-12-02']);
  });
  it('starting mid-week still includes later days that week only', () => {
    expect(expandPattern('2026-11-05', '2026-11-12', [2, 4])).toEqual(['2026-11-05', '2026-11-10', '2026-11-12']);
  });
  it('crosses the daylight-saving change without drifting', () => {
    expect(expandPattern('2026-10-27', '2026-11-10', [2], 2)).toEqual(['2026-10-27', '2026-11-10']);
  });
});

describe('describe', () => {
  it('reads naturally', () => {
    expect(label({ every: 1, days: [4, 2], until: '2027-03-31' })).toBe('Weekly on Tue & Thu until Mar 31');
    expect(label({ every: 2, days: [1, 3, 5], until: '2027-03-31' }, true)).toBe('Every 2 weeks on Monday, Wednesday & Friday until Mar 31');
  });
});

describe('findPatterns', () => {
  it('finds a weekly event entered one date at a time; a missing week becomes a skip', () => {
    const list = [ev('a', '2026-11-04'), ev('b', '2026-11-11'), ev('c', '2026-11-25'), ev('d', '2026-12-02'), ev('x', '2026-11-12', { title: 'Dinner' })];
    const [p, ...rest] = findPatterns(list);
    expect(rest).toEqual([]);
    expect(p.eids).toEqual(['a', 'b', 'c', 'd']);
    expect(p.repeat).toEqual({ every: 1, days: [3], until: '2026-12-02', skipTournaments: true });
    expect(p.skip).toEqual(['2026-11-18']);
  });
  it('matches names loosely and spots every-other-week', () => {
    const list = [ev('a', '2026-11-04', { title: 'open  GYM' }), ev('b', '2026-11-18'), ev('c', '2026-12-02')];
    expect(findPatterns(list)[0].repeat.every).toBe(2);
  });
  it('leaves irregular, too-few, already-repeating and tournament entries alone', () => {
    expect(findPatterns([ev('a', '2026-11-04'), ev('b', '2026-11-11')])).toEqual([]);
    expect(findPatterns([ev('a', '2026-11-04'), ev('b', '2026-11-11'), ev('c', '2026-12-30')])).toEqual([]);
    expect(findPatterns([ev('a', '2026-11-04'), ev('b', '2026-11-05'), ev('c', '2026-11-11')]).length).toBe(1);
    expect(findPatterns(['2026-11-04', '2026-11-11', '2026-11-18'].map((d, i) => ev('t' + i, d, { kind: 'tournament' })))).toEqual([]);
    expect(findPatterns([ev('a', '2026-11-04', { repeat: { every: 1, days: [3], until: '2026-12-01' } }), ev('b', '2026-11-11'), ev('c', '2026-11-18')])).toEqual([]);
  });
});
