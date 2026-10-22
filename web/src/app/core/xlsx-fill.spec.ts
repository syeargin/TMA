import { colLetters, crc32, excelDate, fillTemplate, unzipText, writeZip } from './xlsx-fill';

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const enc = (s: string) => new TextEncoder().encode(s);
const cell = (ref: string, text: string, s = '1') => `<c r="${ref}" s="${s}" t="inlineStr"><is><t>${text}</t></is></c>`;

/** A tiny two-tab workbook shaped like the templates: header, grey example row 2, styled row 3. */
async function template() {
  const roster = `<worksheet xmlns="${NS}"><dimension ref="A1:D3"/><sheetData>` +
    `<row r="1">${cell('A1', 'Jersey', '2')}${cell('B1', 'Player first name *', '2')}${cell('C1', 'Start date', '2')}${cell('D1', 'Allergies', '2')}</row>` +
    `<row r="2" ht="20" customHeight="1">${cell('A2', '7', '3')}${cell('B2', 'Ava', '3')}${cell('C2', '2026-12-12', '3')}${cell('D2', 'None', '3')}</row>` +
    `<row r="3"><c r="A3" s="1"/><c r="B3" s="1"/><c r="C3" s="4"/><c r="D3" s="1"/></row>` +
    `</sheetData></worksheet>`;
  const other = `<worksheet xmlns="${NS}"><sheetData><row r="1">${cell('A1', 'Read me')}</row></sheetData></worksheet>`;
  return writeZip([
    { name: '[Content_Types].xml', bytes: enc('<Types/>') },
    { name: 'xl/workbook.xml', bytes: enc(`<workbook xmlns="${NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Read me" sheetId="1" r:id="rId1"/><sheet name="Roster" sheetId="2" r:id="rId2"/></sheets></workbook>`) },
    { name: 'xl/_rels/workbook.xml.rels', bytes: enc('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="/xl/worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>') },
    { name: 'xl/worksheets/sheet1.xml', bytes: enc(other) },
    { name: 'xl/worksheets/sheet2.xml', bytes: enc(roster) }
  ]);
}

describe('filling an upload template (export)', () => {
  it('basics: column letters, Excel dates, CRC', () => {
    expect([1, 26, 27, 52].map(colLetters)).toEqual(['A', 'Z', 'AA', 'AZ']);
    expect(excelDate('2026-12-12')).toBe(46368);
    expect(excelDate('soon')).toBeNull();
    expect(crc32(enc('hello'))).toBe(0x3610a686);
  });

  it('writes rows from row 2 by header name, as text cells, dates as Excel dates, in the data style', async () => {
    const out = await fillTemplate(await template(), {
      Roster: [
        { 'Jersey': '3', 'Player first name': 'Ivy', 'Start date': '2026-10-06', 'Allergies': '=HYPERLINK("x")' },
        { 'Jersey': '8', 'Player first name': 'June', 'Unknown column': 'ignored' }
      ]
    });
    const doc = new DOMParser().parseFromString(await unzipText(out, 'xl/worksheets/sheet2.xml'), 'application/xml');
    const at = (ref: string) => [...doc.getElementsByTagNameNS(NS, 'c')].find((c) => c.getAttribute('r') === ref)!;
    const val = (ref: string) => at(ref)?.textContent ?? '';
    expect(['A2', 'B2', 'A3', 'B3'].map(val)).toEqual(['3', 'Ivy', '8', 'June']);
    expect(at('A2').getAttribute('t')).toBe('inlineStr');
    expect(at('A2').getAttribute('s')).toBe('1'); // not the grey example style
    expect(at('C2').getAttribute('t')).toBeNull();
    expect(val('C2')).toBe('46301');
    expect(at('C2').getAttribute('s')).toBe('4');
    // A formula-looking value stays text.
    expect(at('D2').getAttribute('t')).toBe('inlineStr');
    expect(at('D2').getElementsByTagNameNS(NS, 'f').length).toBe(0);
    // The rest of the example row is cleared.
    expect(val('D3')).toBe('');
    expect(doc.getElementsByTagNameNS(NS, 'dimension')[0].getAttribute('ref')).toBe('A1:D3');
    // Other tabs are copied as they were.
    expect(await unzipText(out, 'xl/worksheets/sheet1.xml')).toContain('Read me');
  });

  it('adds rows past the template and keeps the example row when a tab has none', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ 'Jersey': String(i + 1), 'Player first name': `P${i + 1}` }));
    const out = await fillTemplate(await template(), { Roster: rows });
    const doc = new DOMParser().parseFromString(await unzipText(out, 'xl/worksheets/sheet2.xml'), 'application/xml');
    expect([...doc.getElementsByTagNameNS(NS, 'row')].map((r) => r.getAttribute('r'))).toEqual(['1', '2', '3', '4', '5', '6']);
    const empty = await fillTemplate(await template(), { Roster: [] });
    expect(await unzipText(empty, 'xl/worksheets/sheet2.xml')).toContain('Ava');
  });
});
