import type { Player } from './models';
import { REF_SETS, fillByRotation, money, safeUrl, sortMeals, toCents, tournamentDays } from './tournament';

const P = (pid: string, refTeam?: 'A' | 'B'): Player => ({ pid, first: pid, refTeam });

describe('fillByRotation', () => {
  const players = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map((p) => P(p)).concat(['b1', 'b2', 'b3', 'b4', 'b5', 'b6'].map((p) => P(p, 'B')));
  const out = fillByRotation(players);
  it('gives every player a job in every set', () => {
    for (const p of players) for (const s of REF_SETS) expect(out[p.pid][s]).toBeTruthy();
  });
  it('covers book, score, libero and two lines in each group and set', () => {
    for (const g of ['a', 'b']) for (const s of REF_SETS) {
      const jobs = players.filter((p) => p.pid.startsWith(g)).map((p) => out[p.pid][s]).sort();
      expect(jobs).toEqual(['Book', 'Libero', 'Lines', 'Lines', 'Off', 'Score']);
    }
  });
  it('rotates jobs between sets', () => {
    expect(out['a1'].s1).not.toBe(out['a1'].s2);
  });
  it('treats players without a group as A', () => {
    expect(Object.keys(fillByRotation([P('x')]))).toEqual(['x']);
  });
});

describe('meals and money', () => {
  it('lists every tournament day', () => {
    expect(tournamentDays('2026-11-14', '2026-11-16')).toEqual(['2026-11-14', '2026-11-15', '2026-11-16']);
    expect(tournamentDays('2026-11-14')).toEqual(['2026-11-14']);
  });
  it('formats and parses dollars', () => {
    expect(money(15000)).toBe('$150');
    expect(money(1250)).toBe('$12.50');
    expect(toCents('12.50')).toBe(1250);
    expect(toCents('$1,200')).toBe(120000);
    expect(toCents('abc')).toBe(0);
    expect(toCents('')).toBe(0);
  });
  it('sorts meals by day then time', () => {
    const ms = sortMeals([
      { eid: 'e', mid: '3', meal: 'Dinner', day: '2026-11-14', time: '6:30 PM' },
      { eid: 'e', mid: '1', meal: 'Lunch', day: '2026-11-14', time: '12:00 PM' },
      { eid: 'e', mid: '2', meal: 'Breakfast', day: '2026-11-15', time: '7:00 AM' }
    ]);
    expect(ms.map((m) => m.mid)).toEqual(['1', '3', '2']);
  });
  it('only turns http(s) addresses into links', () => {
    expect(safeUrl(' https://x.com/a ')).toBe('https://x.com/a');
    expect(safeUrl('javascript:alert(1)')).toBe('');
    expect(safeUrl('Gate B')).toBe('');
  });
});

describe('ball cart and volleyball duty', () => {
  it('separate families, one line when the same family has both, older single field as fallback', async () => {
    const { duties } = await import('./tournament');
    expect(duties({ cartPid: 'p1', ballsPid: 'p2' })).toEqual([{ label: 'Ball cart', pid: 'p1' }, { label: 'Volleyballs', pid: 'p2' }]);
    expect(duties({ cartPid: 'p1', ballsPid: 'p1' })).toEqual([{ label: 'Balls & cart', pid: 'p1' }]);
    expect(duties({ dutyPid: 'p3' })).toEqual([{ label: 'Balls & cart', pid: 'p3' }]);
    expect(duties({ cartPid: 'na', ballsPid: 'na' })).toEqual([{ label: 'Balls & cart', pid: 'na' }]);
    expect(duties({ cartPid: 'p1' })).toEqual([{ label: 'Ball cart', pid: 'p1' }]);
    expect(duties({})).toEqual([]);
  });
});
