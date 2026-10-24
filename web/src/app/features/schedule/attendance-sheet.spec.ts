import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { summarize, type AttendanceRecord } from '@shared/attendance';
import type { ScheduleItem } from '../../core/schedule';
import { TeamStore } from '../../core/team-store';
import { AttendanceCard } from '../team/attendance-card';
import { AttendanceSummary } from '../roster/attendance-summary';
import { AttendanceSheet } from './attendance-sheet';

const players = [
  { pid: 'p1', first: 'Ava', last: 'Stone', jersey: '7' },
  { pid: 'p2', first: 'Bea', last: 'Park', jersey: '11' },
  { pid: 'p3', first: 'Cam', last: 'Ruiz', jersey: '4' }
];
const practice = (key: string, date: string, cancelled = false) => ({ key, kind: 'practice', title: 'Practice', date, end: date, time: '6:00 PM', location: 'Main gym', note: '', travel: false, cancelled }) as ScheduleItem;

function fakeStore(records: AttendanceRecord[], opts: { rsvp?: Record<string, string>; myPid?: string; excusedCounts?: boolean } = {}) {
  const items = [practice('k1', '2026-10-06'), practice('k2', '2026-10-13'), practice('k3', '2026-10-15', true)];
  const keys = new Set(items.filter((i) => !i.cancelled).map((i) => i.key));
  const store = {
    teamId: signal('t13'),
    attendanceFor: signal<ScheduleItem | null>(null),
    players: () => players,
    items: () => items,
    settings: () => ({ attendanceExcusedCounts: opts.excusedCounts }),
    rsvp: (pid: string) => opts.rsvp?.[pid] ?? '',
    attendanceOf: (key: string) => records.find((r) => r.key === key),
    attendanceSummary: (from?: string, to?: string) => summarize(records, players.map((p) => p.pid), { practices: keys, excusedCount: opts.excusedCounts !== false, from, to }),
    has: () => true,
    myPid: () => opts.myPid ?? '',
    playerName: (pid: string) => players.find((p) => p.pid === pid)?.first ?? '',
    saveAttendance: vi.fn(() => Promise.resolve(true))
  };
  TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: TeamStore, useValue: store }] });
  return store;
}
const settle = async () => { await new Promise((r) => setTimeout(r, 0)); TestBed.tick(); };
const text = (el: HTMLElement) => el.textContent!.replace(/\s+/g, ' ');

describe('taking attendance', () => {
  it('starts from the families’ answers, fills the rest as present, and saves only marks', async () => {
    const store = fakeStore([], { rsvp: { p1: 'yes', p2: 'no' } });
    const f = TestBed.createComponent(AttendanceSheet);
    f.detectChanges();
    store.attendanceFor.set(practice('k2', '2026-10-13'));
    await settle();
    const el = f.nativeElement as HTMLElement;
    const pressed = () => [...el.querySelectorAll<HTMLButtonElement>('.att-seg button[aria-pressed=true]')].map((b) => b.textContent!.trim());
    expect(pressed()).toEqual(['Present', 'Excused']);
    expect(text(el)).toContain('1 not marked');
    [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent!.includes('Rest present'))!.click();
    await settle();
    expect(pressed()).toEqual(['Present', 'Excused', 'Present']);
    // Cam was late: change his mark and add a note.
    el.querySelectorAll<HTMLElement>('.att-row')[2].querySelector<HTMLButtonElement>('.m-late')!.click();
    await settle();
    const note = el.querySelectorAll<HTMLElement>('.att-row')[2].querySelector<HTMLInputElement>('.att-note input')!;
    note.value = 'Arrived 6:20'; note.dispatchEvent(new Event('input'));
    [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent!.includes('Save attendance'))!.click();
    await settle();
    expect(store.saveAttendance).toHaveBeenCalledWith('k2', { p1: { s: 'present' }, p2: { s: 'excused' }, p3: { s: 'late', note: 'Arrived 6:20' } });
  });

  it('clears a saved mark by tapping it again', async () => {
    const store = fakeStore([{ key: 'k1', date: '2026-10-06', marks: { p1: { s: 'absent' }, p2: { s: 'present' } } }]);
    const f = TestBed.createComponent(AttendanceSheet);
    f.detectChanges();
    store.attendanceFor.set(practice('k1', '2026-10-06'));
    await settle();
    const el = f.nativeElement as HTMLElement;
    el.querySelectorAll<HTMLElement>('.att-row')[0].querySelector<HTMLButtonElement>('.m-absent')!.click();
    await settle();
    [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent!.includes('Save attendance'))!.click();
    await settle();
    expect(store.saveAttendance).toHaveBeenCalledWith('k1', { p1: null, p2: { s: 'present' } });
  });
});

describe('attendance summaries', () => {
  const records: AttendanceRecord[] = [
    { key: 'k1', date: '2026-10-06', marks: { p1: { s: 'present' }, p2: { s: 'absent' }, p3: { s: 'excused' } } },
    { key: 'k2', date: '2026-10-13', marks: { p1: { s: 'late', note: 'Traffic' }, p2: { s: 'absent' }, p3: { s: 'present' } } },
    { key: 'k3', date: '2026-10-15', marks: { p2: { s: 'present' } } } // cancelled since: doesn't count
  ];

  it('coaches see every player, lowest first, with players under 75% flagged', async () => {
    fakeStore(records);
    const f = TestBed.createComponent(AttendanceSummary);
    f.detectChanges();
    await settle();
    const el = f.nativeElement as HTMLElement;
    const rows = [...el.querySelectorAll('.att-table tbody tr')].map((r) => [...r.children].slice(0, 6).map((c) => text(c as HTMLElement).trim()));
    expect(rows).toEqual([
      ['#11 Bea ParkBelow 75%', '0% · 0 of 2', '0', '0', '0', '2'],
      ['#4 Cam RuizBelow 75%', '50% · 1 of 2', '1', '0', '1', '0'],
      ['#7 Ava Stone', '100% · 2 of 2', '1', '1', '0', '0']
    ]);
    expect(text(el)).toContain('50% 3 of 6');
    expect(text(el)).toContain('2 of 2 held');
  });

  it('a family sees only their own player, with their misses and late arrivals', async () => {
    fakeStore(records, { myPid: 'p1' });
    const f = TestBed.createComponent(AttendanceCard);
    f.detectChanges();
    await settle();
    const el = f.nativeElement as HTMLElement;
    expect(text(el)).toContain("Ava's practice attendance");
    expect(text(el)).toContain('At 2 of 2 practices.');
    expect(text(el)).toContain('Late · “Traffic”');
    expect(text(el)).not.toMatch(/Bea|Cam/);
  });

  it('shows nothing to a family before any attendance is taken', async () => {
    fakeStore([], { myPid: 'p1' });
    const f = TestBed.createComponent(AttendanceCard);
    f.detectChanges();
    await settle();
    expect((f.nativeElement as HTMLElement).querySelector('.att-card')).toBeNull();
  });
});
