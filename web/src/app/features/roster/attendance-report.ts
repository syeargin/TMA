import { MARK_LABELS, MARK_LETTERS, type Mark, type PlayerMark, type PlayerSummary, type Summary } from '@shared/attendance';

/**
 * Attendance reports for the club (Roster › Attendance › Share report / Export to Excel): the same totals
 * the page shows, as a branded PDF, a picture, or an Excel workbook. Everything is made in the browser;
 * nothing is uploaded. Staff only (coaches, team admins, site owners).
 */
export type ReportPractice = { key: string; date: string; title: string; time?: string };
export type ReportPlayer = { pid: string; name: string; short: string; jersey: string; s: PlayerSummary; marks: Record<string, PlayerMark> };
export type Report = {
  club: string; clubShort: string; team: string; season: string;
  colors: { primary: string; accent: string };
  /** "Sep 8 – Nov 12, 2026" and the words for the range ("Season to date"). */
  dates: string; rangeLabel: string;
  practices: ReportPractice[];
  players: ReportPlayer[];
  totals: { present: number; late: number; excused: number; absent: number; attended: number; counted: number; rate: number | null; taken: number; held: number };
  excusedCounts: boolean;
  preparedBy: string; made: string;
  notes: boolean; details: boolean;
};

export const ruleText = (r: Pick<Report, 'excusedCounts'>) =>
  `Attended = present or late, out of practices taken. ${r.excusedCounts ? 'Excused absences count as missed practice.' : 'Excused absences are left out of the percentage.'} Cancelled practices and practices nobody marked don't count.`;

const HEX = /^#[0-9a-f]{6}$/i;
export function reportColors(c?: { primary?: string; accent?: string }) {
  return { primary: c?.primary && HEX.test(c.primary) ? c.primary : '#15294D', accent: c?.accent && HEX.test(c.accent) ? c.accent : '#C8323E' };
}
const rgb = (hex: string): [number, number, number] => [0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16)) as [number, number, number];
const lum = (hex: string) => { const [r, g, b] = rgb(hex).map((c) => c / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
/** Text that reads on a background: white on dark club colors, ink on light ones. */
const onColor = (hex: string) => (lum(hex) > 0.45 ? '#101B2E' : '#FFFFFF');
const initials = (s: string) => (s.match(/\b[A-Za-z0-9]/g) ?? []).slice(0, 3).join('').toUpperCase() || 'TH';

const MARK_FILL: Record<Mark, string> = { present: '#E3F1E6', late: '#FBF0DA', excused: '#E4ECF8', absent: '#FBE6E8' };
const MARK_INK: Record<Mark, string> = { present: '#15532F', late: '#8A5408', excused: '#1F4E8C', absent: '#B42C37' };
const shortDate = (d: string) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;
const dayDate = (d: string) => `${new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })} ${shortDate(d)}`;
const slug = (s: string) => s.replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'team';
export const fileBase = (r: Report) => `${slug(r.team)}-attendance-${r.made}`;

/** Totals for the whole team, from the players' summaries. */
export function teamTotals(summary: Summary, held: number) {
  const add = (k: 'present' | 'late' | 'excused' | 'absent' | 'attended' | 'counted') => summary.players.reduce((n, p) => n + p[k], 0);
  const attended = add('attended'), counted = add('counted');
  return { present: add('present'), late: add('late'), excused: add('excused'), absent: add('absent'), attended, counted, rate: counted ? Math.round((100 * attended) / counted) : null, taken: summary.taken, held };
}

// ---------------------------------------------------------------- PDF (Letter, points)

export async function reportPdf(r: Report): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const W = 612, H = 792, M = 36;
  const fill = (hex: string) => doc.setFillColor(...rgb(hex));
  const ink = (hex: string) => doc.setTextColor(...rgb(hex));
  const head = onColor(r.colors.primary);
  const band = (big: boolean) => {
    const h = big ? 70 : 42;
    fill(r.colors.primary); doc.rect(0, 0, W, h, 'F');
    fill(r.colors.accent); doc.rect(0, h, W, 4, 'F');
    const cs = big ? 38 : 26;
    fill(r.colors.accent); doc.roundedRect(M, (h - cs) / 2, cs, cs, 6, 6, 'F');
    ink(onColor(r.colors.accent)); doc.setFont('helvetica', 'bold'); doc.setFontSize(big ? 14 : 10);
    doc.text(initials(r.clubShort || r.club), M + cs / 2, h / 2 + (big ? 5 : 3.5), { align: 'center' });
    ink(head);
    if (big) {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.text(r.club.toUpperCase(), M + cs + 12, 28);
      doc.setFontSize(18); doc.text(`${r.team} · Attendance`, M + cs + 12, 48);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
      doc.text([r.season, r.dates].filter(Boolean), W - M, 30, { align: 'right' });
    } else {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.text(`${r.team} · Attendance by player`, M + cs + 10, h / 2 + 4);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.text(r.dates, W - M, h / 2 + 4, { align: 'right' });
    }
    return h + 4;
  };

  // Page 1: the summary.
  let y = band(true) + 18;
  const tiles: [string, string][] = [['Attended', r.totals.rate === null ? '–' : `${r.totals.rate}%`], ['Practices', String(r.totals.taken)], ['Late', String(r.totals.late)], ['Excused', String(r.totals.excused)], ['Absent', String(r.totals.absent)]];
  const tw = (W - 2 * M - 4 * 8) / 5;
  tiles.forEach(([k, v], i) => {
    const x = M + i * (tw + 8);
    doc.setDrawColor(225, 230, 238); doc.roundedRect(x, y, tw, 50, 6, 6, 'S');
    ink('#5B677E'); doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.text(k, x + 10, y + 16);
    ink(i === 0 ? '#15532F' : '#101B2E'); doc.setFont('helvetica', 'bold'); doc.setFontSize(20); doc.text(v, x + 10, y + 40);
  });
  y += 70;

  // Attended by week.
  const weeks = new Map<string, { a: number; c: number }>();
  for (const p of r.practices) {
    const d = new Date(`${p.date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    const wk = d.toISOString().slice(0, 10);
    const w = weeks.get(wk) ?? { a: 0, c: 0 };
    for (const pl of r.players) {
      const m = pl.marks[p.key]?.s;
      if (!m || (!r.excusedCounts && m === 'excused')) continue;
      w.c++; if (m === 'present' || m === 'late') w.a++;
    }
    weeks.set(wk, w);
  }
  const wk = [...weeks.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-16);
  if (wk.length > 1) {
    ink('#6C7890'); doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.text('ATTENDED BY WEEK', M, y);
    y += 18;
    const ch = 70, bw = (W - 2 * M) / wk.length;
    wk.forEach(([, v], i) => {
      const pct = v.c ? v.a / v.c : 0;
      fill(r.colors.primary); doc.rect(M + i * bw + 2, y + ch * (1 - pct), bw - 4, ch * pct, 'F');
      ink('#47546C'); doc.setFont('helvetica', 'normal'); doc.setFontSize(7);
      if (v.c) doc.text(`${Math.round(pct * 100)}%`, M + i * bw + bw / 2, y + ch * (1 - pct) - 3, { align: 'center' });
    });
    doc.setDrawColor(221, 227, 236); doc.line(M, y + ch, W - M, y + ch);
    ink('#6C7890'); doc.setFontSize(7.5);
    doc.text(`Week of ${shortDate(wk[0][0])}`, M, y + ch + 11);
    doc.text(`Week of ${shortDate(wk[wk.length - 1][0])}`, W - M, y + ch + 11, { align: 'right' });
    y += ch + 30;
  }

  // Each player's totals.
  const cols = [{ t: 'Player', x: M }, { t: '#', x: M + 200 }, { t: 'Present', x: M + 240 }, { t: 'Late', x: M + 300 }, { t: 'Excused', x: M + 350 }, { t: 'Absent', x: M + 415 }, { t: 'Attended', x: M + 470 }];
  const tableHead = () => {
    ink('#6C7890'); doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
    cols.forEach((c) => doc.text(c.t.toUpperCase(), c.x, y));
    y += 6; doc.setDrawColor(221, 227, 236); doc.line(M, y, W - M, y); y += 14;
  };
  ink('#6C7890'); doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.text('EACH PLAYER', M, y); y += 16;
  tableHead();
  for (const p of r.players) {
    if (y > H - 70) { doc.addPage(); y = band(false) + 24; tableHead(); }
    ink('#101B2E'); doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.text(p.name, M, y);
    doc.setFont('helvetica', 'normal');
    const v = [p.jersey, p.s.present, p.s.late, p.s.excused, p.s.absent].map(String);
    v.forEach((t, i) => doc.text(t, cols[i + 1].x, y));
    doc.setFont('helvetica', 'bold'); doc.text(p.s.rate === null ? '–' : `${p.s.rate}%`, cols[6].x, y);
    y += 6; doc.setDrawColor(238, 241, 245); doc.line(M, y, W - M, y); y += 14;
  }
  y += 6;
  ink('#6C7890'); doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
  doc.text(doc.splitTextToSize(ruleText(r), W - 2 * M), M, Math.min(y, H - 60));

  // Each player's dates: players down the side, up to 14 practices across per page.
  if (r.details && r.practices.length) {
    const per = 14;
    for (let start = 0; start < r.practices.length; start += per) {
      const chunk = r.practices.slice(start, start + per);
      doc.addPage();
      y = band(false) + 22;
      // Key
      doc.setFontSize(8.5);
      let kx = M;
      for (const m of ['present', 'late', 'excused', 'absent'] as Mark[]) {
        fill(MARK_FILL[m]); doc.roundedRect(kx, y - 9, 12, 12, 2, 2, 'F');
        ink(MARK_INK[m]); doc.setFont('helvetica', 'bold'); doc.text(MARK_LETTERS[m], kx + 6, y - 0.5, { align: 'center' });
        ink('#47546C'); doc.setFont('helvetica', 'normal'); doc.text(MARK_LABELS[m], kx + 16, y);
        kx += 16 + doc.getTextWidth(MARK_LABELS[m]) + 14;
      }
      ink('#47546C'); doc.text('–  Not marked', kx, y);
      y += 20;
      const nameW = 110, rateW = 40, cw = (W - 2 * M - nameW - rateW) / per;
      const gridHead = () => {
        ink('#6C7890'); doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5);
        doc.text('PLAYER', M, y);
        chunk.forEach((p, i) => doc.text(shortDate(p.date), M + nameW + i * cw + cw / 2, y, { align: 'center' }));
        doc.text('RATE', W - M, y, { align: 'right' });
        y += 6; doc.setDrawColor(221, 227, 236); doc.line(M, y, W - M, y); y += 14;
      };
      gridHead();
      for (const pl of r.players) {
        if (y > H - 60) { doc.addPage(); y = band(false) + 24; gridHead(); }
        ink('#101B2E'); doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.text(pl.short, M, y);
        chunk.forEach((p, i) => {
          const m = pl.marks[p.key]?.s;
          const cx = M + nameW + i * cw + cw / 2;
          if (m) { fill(MARK_FILL[m]); doc.roundedRect(cx - 6.5, y - 9.5, 13, 13, 2, 2, 'F'); ink(MARK_INK[m]); doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.text(MARK_LETTERS[m], cx, y - 0.5, { align: 'center' }); }
          else { ink('#9AA4B6'); doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.text('–', cx, y - 0.5, { align: 'center' }); }
        });
        ink('#101B2E'); doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
        doc.text(pl.s.rate === null ? '–' : `${pl.s.rate}%`, W - M, y, { align: 'right' });
        y += 5; doc.setDrawColor(238, 241, 245); doc.line(M, y, W - M, y); y += 13;
      }
    }
  }
  if (r.notes) {
    const notes = r.players.flatMap((pl) => r.practices.filter((p) => pl.marks[p.key]?.note).map((p) => `${pl.short} · ${shortDate(p.date)} ${MARK_LABELS[pl.marks[p.key].s].toLowerCase()}: ${pl.marks[p.key].note}`));
    if (notes.length) {
      doc.addPage(); y = band(false) + 24;
      ink('#6C7890'); doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.text("COACHES' NOTES", M, y); y += 16;
      ink('#101B2E'); doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5);
      for (const n of notes) {
        if (y > H - 60) { doc.addPage(); y = band(false) + 24; }
        const lines = doc.splitTextToSize(n, W - 2 * M);
        doc.text(lines, M, y); y += 13 * lines.length;
      }
    }
  }
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setDrawColor(238, 241, 245); doc.line(M, H - 34, W - M, H - 34);
    ink('#6C7890'); doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
    doc.text(i === 1 ? `Prepared by ${r.preparedBy} · ${r.made}` : `${r.club} · ${r.team}`, M, H - 20);
    doc.text(`From Teem Hub · Page ${i} of ${pages}`, W - M, H - 20, { align: 'right' });
  }
  return doc.output('blob');
}

// ---------------------------------------------------------------- Picture (1080 × 1350)

export async function reportPicture(r: Report): Promise<Blob> {
  const fam = { display: '"Big Shoulders Display", "Arial Narrow", sans-serif', cond: '"Barlow Condensed", "Arial Narrow", sans-serif', body: 'Barlow, system-ui, sans-serif' };
  try { await Promise.all(['800 40px "Big Shoulders Display"', '700 40px "Barlow Condensed"', '600 40px Barlow'].map((f) => document.fonts.load(f))); } catch { /* falls back */ }
  const W = 1080, H = 1350, P = 72, BAND = 130;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  const bg = r.colors.primary, ink = onColor(bg), soft = ink === '#FFFFFF' ? 'rgba(255,255,255,.78)' : 'rgba(16,27,46,.7)';
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  // Crest and title
  g.fillStyle = r.colors.accent; g.beginPath(); g.roundRect(P, 64, 96, 96, 18); g.fill();
  g.fillStyle = onColor(r.colors.accent); g.font = `800 44px ${fam.display}`; g.textAlign = 'center'; g.fillText(initials(r.clubShort || r.club), P + 48, 128); g.textAlign = 'left';
  g.fillStyle = soft; g.font = `700 28px ${fam.cond}`; g.fillText(r.club.toUpperCase(), P + 124, 98);
  g.fillStyle = ink; g.font = `800 58px ${fam.display}`; g.fillText(`${r.team} attendance`.toUpperCase(), P + 124, 152);
  g.fillStyle = r.colors.accent; g.fillRect(0, 196, W, 8);
  // Headline
  g.fillStyle = ink; g.font = `700 190px ${fam.cond}`;
  const big = r.totals.rate === null ? '–' : `${r.totals.rate}%`;
  g.fillText(big, P - 6, 400);
  const bw = g.measureText(big).width;
  g.fillStyle = soft; g.font = `600 36px ${fam.body}`;
  g.fillText(`attended · ${r.totals.taken} practices`, P + bw + 28, 338);
  g.fillText(r.dates, P + bw + 28, 386);
  g.fillText(`${r.totals.late} late   ${r.totals.excused} excused   ${r.totals.absent} absent`, P, 462);
  // Players: one or two columns
  const rows = [...r.players].sort((a, b) => (b.s.rate ?? -1) - (a.s.rate ?? -1) || a.short.localeCompare(b.short));
  const top = 510, bottom = H - BAND - 40;
  const twoCols = rows.length > 12;
  const perCol = twoCols ? Math.ceil(rows.length / 2) : rows.length;
  const rowH = Math.min(60, (bottom - top) / Math.max(perCol, 1));
  const colW = twoCols ? (W - 2 * P - 40) / 2 : W - 2 * P;
  g.fillStyle = ink === '#FFFFFF' ? 'rgba(255,255,255,.08)' : 'rgba(16,27,46,.06)';
  g.beginPath(); g.roundRect(P - 20, top - 20, W - 2 * P + 40, Math.min(perCol, 99) * rowH + 30, 20); g.fill();
  rows.slice(0, 40).forEach((p, i) => {
    const col = twoCols ? Math.floor(i / perCol) : 0, row = twoCols ? i % perCol : i;
    const x = P + col * (colW + 40), y = top + row * rowH + rowH * 0.62;
    g.fillStyle = ink; g.font = `600 ${Math.min(34, rowH * 0.6)}px ${fam.body}`;
    g.fillText(p.short, x, y);
    g.font = `700 ${Math.min(34, rowH * 0.6)}px ${fam.body}`; g.textAlign = 'right';
    g.fillText(p.s.rate === null ? '–' : `${p.s.rate}%`, x + colW, y);
    g.textAlign = 'left';
  });
  // Teem Hub band
  g.fillStyle = '#15294D'; g.fillRect(0, H - BAND, W, BAND);
  g.fillStyle = '#C8323E'; g.fillRect(0, H - BAND, W, 8);
  const img = await new Promise<HTMLImageElement | null>((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = '/brand/email-logo-white.png'; });
  if (img) g.drawImage(img, P - 10, H - BAND + 26, 230, 80);
  else { g.fillStyle = '#FFFFFF'; g.font = `800 48px ${fam.display}`; g.fillText('TEEM HUB', P, H - 44); }
  g.fillStyle = 'rgba(255,255,255,.85)'; g.font = `600 30px ${fam.body}`; g.textAlign = 'right';
  g.fillText(r.season || 'teemhub.net', W - P, H - BAND / 2 + 14); g.textAlign = 'left';
  const free = () => { c.width = 0; c.height = 0; };
  return new Promise((res, rej) => c.toBlob((b) => { free(); if (b) res(b); else rej(new Error('no image')); }, 'image/png'));
}

// ---------------------------------------------------------------- Excel (three sheets)

export async function reportXlsx(r: Report): Promise<Blob> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Teem Hub';
  const argb = (hex: string) => 'FF' + hex.slice(1).toUpperCase();
  const brand = (ws: import('exceljs').Worksheet, title: string, width: number) => {
    ws.mergeCells(1, 1, 1, width);
    const t = ws.getCell(1, 1);
    t.value = `${r.club} · ${r.team} · ${title}`;
    t.font = { bold: true, size: 14, color: { argb: argb(onColor(r.colors.primary)) } };
    t.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(r.colors.primary) } };
    t.border = { bottom: { style: 'thick', color: { argb: argb(r.colors.accent) } } };
    ws.getRow(1).height = 26;
    ws.mergeCells(2, 1, 2, width);
    ws.getCell(2, 1).value = [r.season, `${r.dates} · ${r.totals.taken} practices`, `exported ${r.made} by ${r.preparedBy}`].filter(Boolean).join(' · ');
    ws.getCell(2, 1).font = { color: { argb: 'FF555555' } };
  };
  const header = (row: import('exceljs').Row) => row.eachCell((c) => { c.font = { bold: true }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF8' } }; });
  const pct = (n: number | null) => (n === null ? null : n / 100);

  // Summary
  const s = wb.addWorksheet('Summary', { views: [{ state: 'frozen', ySplit: 6 }] });
  brand(s, 'Attendance', 8);
  s.getRow(4).values = ['Team attended', pct(r.totals.rate), 'Late', r.totals.late, 'Excused', r.totals.excused, 'Absent', r.totals.absent];
  s.getCell(4, 1).font = { bold: true }; s.getCell(4, 2).font = { bold: true }; s.getCell(4, 2).numFmt = '0%';
  s.getRow(6).values = ['Player', 'Jersey', 'Present', 'Late', 'Excused', 'Absent', 'Practices counted', 'Attended'];
  header(s.getRow(6));
  for (const p of r.players) {
    const row = s.addRow([p.name, p.jersey || null, p.s.present, p.s.late, p.s.excused, p.s.absent, p.s.counted, pct(p.s.rate)]);
    row.getCell(8).numFmt = '0%';
  }
  s.addRow([]);
  const rule = s.addRow([ruleText(r)]);
  s.mergeCells(rule.number, 1, rule.number, 8);
  rule.getCell(1).font = { italic: true, color: { argb: 'FF6C7890' } };
  s.columns.forEach((c, i) => { c.width = i === 0 ? 26 : 12; });

  // By date
  const d = wb.addWorksheet('By date', { views: [{ state: 'frozen', xSplit: 1, ySplit: 4 }] });
  brand(d, 'Attendance by date', r.practices.length + 2);
  d.getRow(4).values = ['Player', ...r.practices.map((p) => dayDate(p.date)), 'Attended'];
  header(d.getRow(4));
  for (const p of r.players) {
    const row = d.addRow([p.name, ...r.practices.map((pr) => (p.marks[pr.key] ? MARK_LABELS[p.marks[pr.key].s] : '')), pct(p.s.rate)]);
    r.practices.forEach((pr, i) => {
      const m = p.marks[pr.key]?.s;
      if (m) row.getCell(i + 2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(MARK_FILL[m]) } };
    });
    row.getCell(r.practices.length + 2).numFmt = '0%';
  }
  d.columns.forEach((c, i) => { c.width = i === 0 ? 26 : 11; });

  // Every mark
  const e = wb.addWorksheet('Every mark', { views: [{ state: 'frozen', ySplit: 4 }] });
  const cols = r.notes ? 6 : 5;
  brand(e, 'Every mark', cols);
  e.getRow(4).values = ['Date', 'Practice', 'Player', 'Jersey', 'Mark', ...(r.notes ? ['Note'] : [])];
  header(e.getRow(4));
  for (const pr of r.practices) {
    for (const p of r.players) {
      const m = p.marks[pr.key];
      if (!m) continue;
      const row = e.addRow([new Date(`${pr.date}T12:00:00Z`), [pr.title, pr.time].filter(Boolean).join(' · '), p.name, p.jersey || null, MARK_LABELS[m.s], ...(r.notes ? [m.note ?? ''] : [])]);
      row.getCell(1).numFmt = 'yyyy-mm-dd';
    }
  }
  e.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: cols } };
  e.columns.forEach((c, i) => { c.width = [12, 24, 26, 8, 10, 40][i] ?? 12; });

  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
