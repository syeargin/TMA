import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import ExcelJS from 'exceljs';
import { MeService } from '../../core/me.service';
import { TeamStore } from '../../core/team-store';
import { fileBase, reportColors, reportPdf, reportXlsx, ruleText, teamTotals, type Report } from './attendance-report';
import { AttendanceSummary } from './attendance-summary';

const s = (pid: string, present: number, late: number, excused: number, absent: number) => {
  const marked = present + late + excused + absent, attended = present + late;
  return { pid, present, late, excused, absent, marked, attended, counted: marked, rate: Math.round((100 * attended) / marked), last: [] };
};
const report = (o: Partial<Report> = {}): Report => ({
  club: 'Summit Volleyball Club', clubShort: 'Summit VBC', team: '13 Navy', season: '2026-27',
  colors: reportColors({ primary: '#15294D', accent: '#C8323E' }), dates: 'Sep 8 – Sep 10, 2026', rangeLabel: 'Season to date',
  practices: [{ key: 'pr-1-2026-09-08', date: '2026-09-08', title: 'Practice', time: '6:00 PM' }, { key: 'pr-1-2026-09-10', date: '2026-09-10', title: 'Practice' }],
  players: [
    { pid: 'p1', name: 'Ava Carter', short: 'Ava C.', jersey: '7', s: s('p1', 2, 0, 0, 0), marks: { 'pr-1-2026-09-08': { s: 'present' }, 'pr-1-2026-09-10': { s: 'present' } } },
    { pid: 'p2', name: 'Mia Brooks', short: 'Mia B.', jersey: '11', s: s('p2', 0, 1, 1, 0), marks: { 'pr-1-2026-09-08': { s: 'late', note: 'Arrived 6:20' }, 'pr-1-2026-09-10': { s: 'excused' } } }
  ],
  totals: { present: 2, late: 1, excused: 1, absent: 0, attended: 3, counted: 4, rate: 75, taken: 2, held: 2 },
  excusedCounts: true, preparedBy: 'Coach Kim Lee', made: '2026-11-13', notes: false, details: true, ...o
});
const read = async (b: Blob) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await b.arrayBuffer()); return wb; };

describe('attendance reports', () => {
  it('adds up the team and says how the rate is counted', () => {
    const t = teamTotals({ players: [s('a', 2, 0, 0, 0), s('b', 0, 1, 1, 0)], taken: 2 } as never, 3);
    expect(t).toMatchObject({ present: 2, late: 1, excused: 1, attended: 3, counted: 4, rate: 75, taken: 2, held: 3 });
    expect(ruleText({ excusedCounts: false })).toContain('left out of the percentage');
    expect(reportColors({ primary: 'red' })).toEqual({ primary: '#15294D', accent: '#C8323E' });
    expect(fileBase(report())).toBe('13-navy-attendance-2026-11-13');
  });

  it('exports a branded workbook with Summary, By date and Every mark sheets, notes only when asked', async () => {
    let wb = await read(await reportXlsx(report()));
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Summary', 'By date', 'Every mark']);
    const sum = wb.getWorksheet('Summary')!;
    expect(String(sum.getCell('A1').value)).toBe('Summit Volleyball Club · 13 Navy · Attendance');
    expect(sum.getCell('B4').value).toBe(0.75);
    expect(sum.getRow(7).values).toEqual([undefined, 'Ava Carter', '7', 2, 0, 0, 0, 2, 1]);
    expect(wb.getWorksheet('By date')!.getRow(6).getCell(2).value).toBe('Late');
    const marks = wb.getWorksheet('Every mark')!;
    expect(marks.getRow(4).values).toEqual([undefined, 'Date', 'Practice', 'Player', 'Jersey', 'Mark']);
    expect(marks.rowCount).toBe(8);
    wb = await read(await reportXlsx(report({ notes: true })));
    expect(wb.getWorksheet('Every mark')!.getRow(6).getCell(6).value).toBe('Arrived 6:20');
  });

  it('makes a PDF', async () => {
    const b = await reportPdf(report({ notes: true }));
    expect(b.type).toBe('application/pdf');
    expect(new TextDecoder().decode((await b.arrayBuffer()).slice(0, 5) as ArrayBuffer)).toBe('%PDF-');
  });

  it('offers Share report and Export to Excel to coaches and team admins, not coordinators', () => {
    const make = (roles: string[]) => {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({ providers: [{ provide: MeService, useValue: { label: () => 'Coach Kim' } }, { provide: TeamStore, useValue: {
        teamId: signal('t13'), you: () => ({ roles }), players: () => [], items: () => [], settings: () => ({}), club: () => null, teamName: () => '13 Navy',
        attendanceSummary: () => ({ players: [], taken: 1, teamRate: 90, attended: 9, counted: 10 }), attendanceOf: () => undefined, attendanceFor: signal(null)
      } }] });
      const f = TestBed.createComponent(AttendanceSummary);
      f.detectChanges();
      return [...(f.nativeElement as HTMLElement).querySelectorAll('button')].map((b) => b.textContent!.trim());
    };
    expect(make(['coach'])).toEqual(expect.arrayContaining(['Share report', 'Export to Excel']));
    expect(make(['admin'])).toContain('Share report');
    const coord = make(['coordinator']);
    expect(coord).not.toContain('Share report');
    expect(coord).toContain('Download');
  });
});
