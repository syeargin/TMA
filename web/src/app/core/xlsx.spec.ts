import { toCell, toSheets, workbookKind } from './xlsx';

describe('xlsx', () => {
  it('turns dates into YYYY-MM-DD and times of day into 6:30 PM, whatever the time zone', () => {
    expect(toCell(new Date(Date.UTC(2026, 11, 5)))).toBe('2026-12-05');
    expect(toCell(new Date(Date.UTC(1899, 11, 30, 18, 30)))).toBe('6:30 PM');
    expect(toCell(new Date(Date.UTC(1899, 11, 30, 0, 5)))).toBe('12:05 AM');
    expect(toCell(new Date(Date.UTC(1899, 11, 30, 12, 0)))).toBe('12:00 PM');
    expect(toCell(400)).toBe(400);
    expect(toCell(undefined)).toBeNull();
  });

  it('drops the instructions and choices tabs and trailing blanks', () => {
    const s = toSheets([
      { sheet: 'Read me', data: [['Team setup']] },
      { sheet: 'Roster', data: [['Jersey', 'Name', null], ['7', 'Ava', null], [null, '', null]] },
      { sheet: 'Team', data: [['Team name']] },
      { sheet: 'Choices', data: [['Y']] }
    ]);
    expect(s).toEqual({ Roster: [['Jersey', 'Name'], ['7', 'Ava']], Team: [['Team name']] });
    expect(workbookKind(s)).toBe('team');
    expect(workbookKind({ Club: [], Teams: [] })).toBe('club');
    expect(workbookKind({ Sheet1: [] })).toBeNull();
  });
});
