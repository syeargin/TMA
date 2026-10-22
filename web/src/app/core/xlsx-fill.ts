/**
 * Writes exported rows into a copy of an upload template (web/public/templates), keeping its Read me
 * tab, column notes, dropdowns and formatting. An .xlsx is a zip of XML files; this reads and writes
 * the zip with the browser's own (de)compression, so there's no spreadsheet library to ship.
 *
 * Values go in as text, numbers, or dates (as Excel dates, in the template's date columns). Text is
 * stored as text cells, so nothing in a name or note can turn into a spreadsheet formula.
 */
export type ExportCell = string | number | boolean | null;
export type ExportRows = Record<string, ExportCell>[];

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
/** Template columns that hold dates: written as Excel dates so they show as dates and keep the date checks. */
const DATE_COLS = new Set(['dues due date', 'first date', 'last date', 'start date', 'end date', 'book hotel by', 'repeat until']);

// ---------------------------------------------------------------- zip

type Entry = { name: string; method: number; crc: number; size: number; data: Uint8Array /* compressed as stored */; changed?: Uint8Array };

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

async function pipe(bytes: Uint8Array, through: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }): Promise<Uint8Array> {
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }).pipeThrough(through);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
const inflate = (b: Uint8Array) => pipe(b, new DecompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>);
const deflate = (b: Uint8Array) => pipe(b, new CompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>);

let crcTable: Uint32Array | null = null;
export function crc32(b: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function readZip(buf: Uint8Array): Entry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (u32(buf, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("The template file isn't a valid workbook.");
  const count = u16(buf, eocd + 10);
  let p = u32(buf, eocd + 16);
  const out: Entry[] = [];
  for (let i = 0; i < count; i++) {
    if (u32(buf, p) !== 0x02014b50) throw new Error("The template file isn't a valid workbook.");
    const method = u16(buf, p + 10), crc = u32(buf, p + 16), csize = u32(buf, p + 20), size = u32(buf, p + 24);
    const nlen = u16(buf, p + 28), xlen = u16(buf, p + 30), clen = u16(buf, p + 32), local = u32(buf, p + 42);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nlen));
    const start = local + 30 + u16(buf, local + 26) + u16(buf, local + 28);
    out.push({ name, method, crc, size, data: buf.subarray(start, start + csize) });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

async function readEntry(e: Entry): Promise<Uint8Array> {
  if (e.changed) return e.changed;
  return e.method === 8 ? inflate(e.data) : e.data;
}

export async function writeZip(entries: { name: string; bytes: Uint8Array; raw?: Entry }[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = new TextEncoder().encode(e.name);
    const raw = e.raw && !e.raw.changed ? e.raw : null;
    const data = raw ? raw.data : await deflate(e.bytes);
    const method = raw ? raw.method : 8, crc = raw ? raw.crc : crc32(e.bytes), size = raw ? raw.size : e.bytes.length;
    const head = new Uint8Array(30 + name.length), h = new DataView(head.buffer);
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, method, true);
    h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, size, true); h.setUint16(26, name.length, true);
    head.set(name, 30);
    const cd = new Uint8Array(46 + name.length), c = new DataView(cd.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, method, true);
    c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, size, true); c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    cd.set(name, 46);
    parts.push(head, data); central.push(cd);
    offset += head.length + data.length;
  }
  const cdSize = central.reduce((n, x) => n + x.length, 0);
  const end = new Uint8Array(22), d = new DataView(end.buffer);
  d.setUint32(0, 0x06054b50, true); d.setUint16(8, entries.length, true); d.setUint16(10, entries.length, true);
  d.setUint32(12, cdSize, true); d.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of all) { out.set(x, o); o += x.length; }
  return out;
}

// ---------------------------------------------------------------- cells

/** "A" → 1, "AB" → 28 */
const colNum = (letters: string) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
export const colLetters = (n: number) => { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const refCol = (ref: string) => colNum(/^[A-Z]+/.exec(ref)![0]);

/** Days since 30 Dec 1899, as Excel stores dates. */
export function excelDate(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86400000) : null;
}

function cellText(c: Element, shared: string[]): string {
  const t = c.getAttribute('t');
  if (t === 'inlineStr') return [...c.getElementsByTagNameNS(NS, 't')].map((x) => x.textContent ?? '').join('');
  const v = c.getElementsByTagNameNS(NS, 'v')[0]?.textContent ?? '';
  return t === 's' ? shared[Number(v)] ?? '' : v;
}

const norm = (h: string) => h.replace(/\s*\*\s*$/, '').trim().toLowerCase();

function setCell(doc: Document, c: Element, value: ExportCell, isDate: boolean) {
  while (c.firstChild) c.removeChild(c.firstChild);
  c.removeAttribute('t');
  if (value === null || value === '') return;
  const serial = isDate && typeof value === 'string' ? excelDate(value) : null;
  if (typeof value === 'number' || serial !== null) {
    const v = doc.createElementNS(NS, 'v');
    v.textContent = String(serial ?? value);
    c.appendChild(v);
    return;
  }
  c.setAttribute('t', 'inlineStr');
  const is = doc.createElementNS(NS, 'is'), t = doc.createElementNS(NS, 't');
  t.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
  t.textContent = typeof value === 'boolean' ? (value ? 'Y' : 'N') : String(value);
  is.appendChild(t);
  c.appendChild(is);
}

/** Fills one worksheet: row 1 is the header; data goes from row 2 (over the example row). */
function fillSheet(xml: string, rows: ExportRows, shared: string[]): string {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const data = doc.getElementsByTagNameNS(NS, 'sheetData')[0];
  const rowEls = new Map<number, Element>();
  for (const r of [...data.getElementsByTagNameNS(NS, 'row')]) rowEls.set(Number(r.getAttribute('r')), r);
  const header = rowEls.get(1);
  if (!header) return xml;
  const cols = new Map<string, number>();
  for (const c of [...header.getElementsByTagNameNS(NS, 'c')]) cols.set(norm(cellText(c, shared)), refCol(c.getAttribute('r') ?? 'A1'));
  if (!rows.length) return xml; // keep the example row: the importer skips it while it's unchanged
  const maxCol = Math.max(...cols.values());
  // Style for data cells in each column: row 3's (row 2 is the grey example row).
  const style = new Map<number, string>();
  for (const c of [...(rowEls.get(3)?.getElementsByTagNameNS(NS, 'c') ?? [])]) { const s = c.getAttribute('s'); if (s) style.set(refCol(c.getAttribute('r')!), s); }

  const rowEl = (n: number) => {
    let r = rowEls.get(n);
    if (r) return r;
    r = doc.createElementNS(NS, 'row');
    r.setAttribute('r', String(n));
    const after = [...rowEls.keys()].filter((k) => k > n).sort((a, b) => a - b)[0];
    data.insertBefore(r, after ? rowEls.get(after)! : null);
    rowEls.set(n, r);
    return r;
  };
  const cellEl = (row: Element, n: number, col: number) => {
    const ref = `${colLetters(col)}${n}`;
    const cells = [...row.getElementsByTagNameNS(NS, 'c')];
    let c = cells.find((x) => x.getAttribute('r') === ref);
    if (c) return c;
    c = doc.createElementNS(NS, 'c');
    c.setAttribute('r', ref);
    row.insertBefore(c, cells.find((x) => refCol(x.getAttribute('r')!) > col) ?? null);
    return c;
  };

  rows.forEach((values, i) => {
    const n = i + 2;
    const row = rowEl(n);
    if (n === 2) { row.removeAttribute('ht'); row.removeAttribute('customHeight'); }
    const byCol = new Map<number, ExportCell>();
    for (const [k, v] of Object.entries(values)) { const col = cols.get(norm(k)); if (col) byCol.set(col, v); }
    for (let col = 1; col <= maxCol; col++) {
      const v = byCol.get(col) ?? null;
      const existing = [...row.getElementsByTagNameNS(NS, 'c')].find((x) => x.getAttribute('r') === `${colLetters(col)}${n}`);
      if (v === null && !existing) continue;
      const c = existing ?? cellEl(row, n, col);
      const s = style.get(col);
      if (s) c.setAttribute('s', s); else c.removeAttribute('s');
      const head = [...cols.entries()].find(([, k]) => k === col)?.[0] ?? '';
      setCell(doc, c, v, DATE_COLS.has(head));
    }
  });
  const dim = doc.getElementsByTagNameNS(NS, 'dimension')[0];
  const last = Math.max(...rowEls.keys());
  if (dim) dim.setAttribute('ref', `A1:${colLetters(maxCol)}${last}`);
  return new XMLSerializer().serializeToString(doc);
}

/** A copy of the template with each tab's rows written in. Tabs not in `sheets` are left as they are. */
export async function fillTemplate(template: ArrayBuffer | Uint8Array, sheets: Record<string, ExportRows>): Promise<Uint8Array> {
  const entries = readZip(template instanceof Uint8Array ? template : new Uint8Array(template));
  const byName = new Map(entries.map((e) => [e.name.replace(/^\//, ''), e]));
  const text = async (name: string) => { const e = byName.get(name); return e ? new TextDecoder().decode(await readEntry(e)) : ''; };

  const shared: string[] = [];
  const ss = await text('xl/sharedStrings.xml');
  if (ss) {
    const d = new DOMParser().parseFromString(ss, 'application/xml');
    for (const si of [...d.getElementsByTagNameNS(NS, 'si')]) shared.push([...si.getElementsByTagNameNS(NS, 't')].map((t) => t.textContent ?? '').join(''));
  }
  const wb = new DOMParser().parseFromString(await text('xl/workbook.xml'), 'application/xml');
  const rels = new DOMParser().parseFromString(await text('xl/_rels/workbook.xml.rels'), 'application/xml');
  const target = new Map([...rels.getElementsByTagName('Relationship')].map((r) => [r.getAttribute('Id')!, r.getAttribute('Target')!]));
  for (const sh of [...wb.getElementsByTagNameNS(NS, 'sheet')]) {
    const tab = sh.getAttribute('name')!;
    const rows = sheets[tab];
    if (!rows) continue;
    let path = target.get(sh.getAttributeNS(REL_NS, 'id') ?? '') ?? '';
    path = path.startsWith('/') ? path.slice(1) : `xl/${path}`;
    const e = byName.get(path);
    if (!e) continue;
    e.changed = new TextEncoder().encode(fillSheet(await text(path), rows, shared));
  }
  return writeZip(await Promise.all(entries.map(async (e) => ({ name: e.name, bytes: e.changed ?? new Uint8Array(), raw: e }))));
}

/** One file from inside a workbook, as text (tests and checks). */
export async function unzipText(bytes: Uint8Array, name: string): Promise<string> {
  const e = readZip(bytes).find((x) => x.name.replace(/^\//, '') === name);
  return e ? new TextDecoder().decode(await readEntry(e)) : '';
}
