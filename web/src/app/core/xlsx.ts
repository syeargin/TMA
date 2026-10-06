/**
 * Reads an .xlsx in the browser into plain rows for the import API: dates become YYYY-MM-DD text and
 * times "6:30 PM", so nothing depends on the viewer's time zone. The reader is loaded only when used.
 */
export type Cell = string | number | boolean | null;
export type Sheets = Record<string, Cell[][]>;

const pad = (n: number) => String(n).padStart(2, '0');

export function toCell(v: unknown): Cell {
  if (v instanceof Date) {
    // Excel keeps times of day as dates on 30 Dec 1899.
    if (v.getUTCFullYear() < 1901) {
      const h = v.getUTCHours(), m = v.getUTCMinutes();
      return `${((h + 11) % 12) + 1}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
    }
    return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
  }
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : null;
}

/** Every tab except the instructions and the hidden list of choices; blank rows at the end dropped. */
export function toSheets(all: { sheet: string; data: unknown[][] }[]): Sheets {
  const out: Sheets = {};
  for (const s of all) {
    if (/^(read me|choices)$/i.test(s.sheet.trim())) continue;
    const rows = s.data.map((r) => r.map(toCell));
    while (rows.length && !rows[rows.length - 1].some((c) => c !== null && String(c).trim() !== '')) rows.pop();
    out[s.sheet.trim()] = rows.map((r) => {
      const row = [...r];
      while (row.length && (row[row.length - 1] === null || row[row.length - 1] === '')) row.pop();
      return row;
    });
  }
  return out;
}

export function workbookKind(sheets: Sheets): 'team' | 'club' | null {
  const names = new Set(Object.keys(sheets).map((n) => n.toLowerCase()));
  if (names.has('teams') && (names.has('club') || names.has('rosters'))) return 'club';
  if (names.has('team') && names.has('roster')) return 'team';
  return null;
}

export async function readWorkbook(file: File): Promise<Sheets> {
  if (!/\.xlsx$/i.test(file.name)) throw new Error('Choose an Excel workbook (.xlsx). In Google Sheets, use File › Download › Microsoft Excel.');
  if (file.size > 8 * 1024 * 1024) throw new Error('That file is over 8 MB. Remove extra tabs or images and try again.');
  const { default: read } = await import('read-excel-file/browser');
  try {
    return toSheets(await read(file) as { sheet: string; data: unknown[][] }[]);
  } catch {
    throw new Error("That file couldn't be read as an Excel workbook. Save it as .xlsx and try again.");
  }
}
